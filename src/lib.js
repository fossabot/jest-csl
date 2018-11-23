Array.prototype.flatMap = function(lambda) { 
    return Array.prototype.concat.apply([], this.map(lambda)); 
};

const CSL = require("citeproc");
const log = require('loglevel');
const path = require('path');
const os = require('os');
const osenv = require('osenv');
const uuid = require('uuid');
const yaml = require('js-yaml');
const glob = require('glob');
const xdgBasedir = require('xdg-basedir');
const fs = require('fs');
const fse = require('fs-extra');
const mkdirp = require('mkdirp');
const git = require('nodegit');

const { normalizeKey, lookupKey, makeGetAbbreviation } = require('./getAbbreviation');

function cloneOrPull(url, repoDir, branch, shouldPull) {
  let repo;
  let logger = log.getLogger('ensureCachedRepos');
  return git.Repository.open(repoDir)
    .then(r => { repo = r; })
    .then(() => {
      if (shouldPull) {
        return Promise.resolve()
        .then(() => repo.fetchAll())
        .then(() => repo.mergeBranches(branch, 'origin/' + branch))
        .then(() => logger.info(`pulled repo ${repoDir}`))
      }
    })
    .catch((e) => {
      log.info(`repo ${repoDir} not cached; fetching`)
      return fse.remove(repoDir)
        .then(() => git.Clone(url, repoDir));
    })
}

// returns a Promise
function ensureCachedRepos(shouldPull) {
  let cacheDir = getDefaultCacheDir();
  mkdirp(cacheDir);
  return Promise.resolve()
    .then(() => cloneOrPull("https://github.com/citation-style-language/locales",
                            _cacheLoc('locales'),
                            'master',
                            shouldPull))
    .then(() => cloneOrPull("https://github.com/Juris-M/style-modules",
                            _cacheLoc('style-modules'),
                            'master',
                            shouldPull))
  ;
}

const citeprocSys = (citations, jurisdictionDirs, myAbbreviations, gotAbbreviationCache) => ({
  retrieveLocale: function (lang) {
    let ctx = log.getLogger('sys')
    ctx.debug('retrieving locale: %s', lang);
    let p = path.join(_cacheLoc('locales'), 'locales-'+lang+'.xml');
    let locale = fs.readFileSync(p, 'utf8')
    return locale;
  },

  retrieveItem(id){
    return citations[id];
  },

  getAbbreviation: makeGetAbbreviation(myAbbreviations, gotAbbreviationCache),

  retrieveStyleModule(jurisdiction, preference) {
    let cp = log.getLogger('sys')
    let jp = jurisdiction + (preference ? '-' + preference : '')
    cp.debug(`retrieving style module: ${jp}`);
    let ctx = log.getLogger(`sys > retrieve ${jp}`)

    jurisdiction = jurisdiction.replace(/\:/g, "+");
    var id = preference
      ? "juris-" + jurisdiction + "-" + preference + ".csl"
      : "juris-" + jurisdiction + ".csl";
    let shouldLog = false;
    let tryFile = (x) => {
      ctx.trace(`searching ${x}`)
      let t = fs.readFileSync(x, 'utf8')
      if (t) ctx.trace(`found ${x}`)
      return t;
    }
    jurisdictionDirs.push(_cacheLoc('style-modules'));
    let ord = jurisdictionDirs
      .map(d => () => tryFile(path.join(d, id)));
    let ret = false;
    for (var i = 0; i < ord.length; i++) {
      try {
        ret = ord[i]();
        if (ret) {
          return ret;
        };
      } catch (e) {
        continue;
      }
    }
    return ret;
  }
});

// @param library Array of CSL-JSON item objects.
function readLibrary(library) {
  let citations = {};
  let itemIDs = new Set();
  for (var i=0,ilen=library.length;i<ilen;i++) {
    var item = library[i];
    var id = item.id;
    citations[id] = item;
    itemIDs.add(id);
  }
  return [citations, [...itemIDs]]
}

function _atIndex(c, i) {
  return {
    citationID: "CITATION-"+i,
    properties: { noteIndex: i },
    citationItems: c
  }
}

function _addTestsToMap(m, u) {
  for (let t of u.tests) {
    m.set(t.it, t);
  }
}

function _mergeUnit(a, b) {
  let m = new Map();
  _addTestsToMap(m, a);
  _addTestsToMap(m, b);
  return {
    describe: a.describe,
    tests: [...m.values()]
  }
}

function _addUnitsToMap(m, us) {
  if (!Array.isArray(us)) {
    return;
  }
  for (let u of us) {
    let k = u.describe;
    if (m.has(k)) {
      m.set(k, _mergeUnit(m.get(k), u))
    } else {
      m.set(k, u);
    }
  }
}

function mergeUnits(unitsA, unitsB) {
  let m = new Map();
  _addUnitsToMap(m, unitsA);
  _addUnitsToMap(m, unitsB);
  return [...m.values()];
}

function _bail(msg) {
  log.error(msg);
  process.exit(1);
}

function getDefaultCacheDir() {
  const user = (osenv.user() || uuid.v4()).replace(/\\/g, '');
  let cacheDir = xdgBasedir.cache || path.join(os.tempdir(), user, '.cache')
  cacheDir = path.join(cacheDir, 'jest-csl');
  return cacheDir;
}

function _cacheLoc(r) {
  return path.join(getDefaultCacheDir(), r);
}

function expandGlobs(gs) {
  return (gs || []).flatMap(s => {
    return glob.sync(s);
  });
}

function insertMissingPageLabels(test) {
  let immut = (single) => {
    return (single.locator && !single.label) 
      ? { ... single, label: single.label || 'page' }
      : single;
  };
  if (test.single && test.single.locator && !test.single.label) {
    return { ...test, single: immut(test.single) };
  }
  if (test.sequence) {
    return {
      ...test,
      sequence: test.sequence.map(s => s.map(immut))
    }
  }
  return test;
}


function stripWhitespace(test) {
  let expect = '';
  if (Array.isArray(test.expect)) {
    expect = test.expect.map(e => e.trim());
  } else {
    expect = test.expect && test.expect.trim();
  }
  return {
    ...test,
    expect: test.expect && expect
  }
}

function normalizeItalics(testString) {
  return testString.replace(new RegExp("</i>(\\s*)<i>"), "$1")
}

function readConfigFiles(args) {
  let style = fs.readFileSync(args.csl, 'utf8');
  if (!style) {
    _bail("style not loaded");
  }

  let library = [];

  let libraries = expandGlobs(args.libraries);
  for (var lib of libraries) {
    var libStr = fs.readFileSync(lib, 'utf8');
    if (libStr == null) {
      _bail("library file " + lib + "empty or nonexistent");
    }
    var parsed = JSON.parse(libStr);
    if (!Array.isArray(parsed)) {
      _bail("parsed library not an array of references");
    }
    library = library.concat(parsed);
  }
  if (args.suites.length === 0) {
    _bail('no test args.suites provided');
  }

  let jurisdictionDirs = expandGlobs(args.jurisdictionDirs);

  let out = { style, library, jurisdictionDirs };
  return out;
}

function readTestUnits(suites) {
  let units = [];
  let _suites = expandGlobs(suites);
  for (let suite of _suites) {
    let unitsStr = fs.readFileSync(suite, 'utf8');
    let nxtUnits = yaml.safeLoad(unitsStr);
    units = mergeUnits(units, nxtUnits);
  }
  units = units.map(unit => {
    return {
      ...unit,
      tests: unit.tests.map(stripWhitespace).map(insertMissingPageLabels)
    }
  });
  return units;
}

class TestEngine {
  constructor(args) {
    this.logger = args.logger || log.getLogger('TestEngine');

    let { style, library, jurisdictionDirs } = readConfigFiles(args);
    let [citations, itemIDs] = readLibrary(library);

    this.abbreviations = {};
    this.sysAbbreviationCache = null;

    const sys = citeprocSys(
      citations,
      jurisdictionDirs,
      () => this.abbreviations,
      cache => { this.sysAbbreviationCache = cache; }
    );

    this.engine = new CSL.Engine(sys, style);
    this.engine.updateItems(itemIDs);

  }

  retrieveItem(item) {
    return this.engine.retrieveItem(item);
  }

  setAbbreviations(sets) {
    this.abbreviations = {
      default: new CSL.AbbreviationSegments()
    };
    if (this.sysAbbreviationCache) {
      this.logger.trace("clearing sysAbbreviationCache");
      Object.keys(this.sysAbbreviationCache).forEach(k => delete this.sysAbbreviationCache[k]);
      this.sysAbbreviationCache['default'] = new CSL.AbbreviationSegments();
    }
    if (!sets) return;
    sets.forEach(set => {
      let jurisdiction = set.jurisdiction || 'default';
      let categories = Object.keys(new CSL.AbbreviationSegments());
      categories.forEach(cat => {
        let kvs = set[cat] || {};
        Object.entries(kvs).forEach(e => {
          this.addAbbreviation(jurisdiction, cat, e[0], e[1]);
        })
      });
    })
  }

  produceSingle(single, format, abbreviations) {
    // engine.makeCitationCluster([single], 'html') is broken, but it's meant to be faster.
    // (it tries to access 'disambig of undefined'... not helpful)
    // (node_modules/citeproc/citeproc_commonjs.js +10874)
    let out = this.produceSequence([[single]], format || 'html', abbreviations)
    return out[0];
  }

  produceSequence(clusters, format, abbreviations) {
    this.setAbbreviations(abbreviations);
    let citations = clusters.map((c, i) => _atIndex(c, i+1))
    let out = this.engine.rebuildProcessorState(citations, format || 'html')
    return out.map(o => o[2]);
  }

  addAbbreviation(jurisdiction, category, key, value) {
    this.logger.info(`adding abbreviation: ${jurisdiction}.${category}["${key}"] = "${value}"`);
    this.abbreviations[jurisdiction] = this.abbreviations[jurisdiction] || new CSL.AbbreviationSegments();
    let k = lookupKey(normalizeKey(key));
    this.abbreviations[jurisdiction][category][k] = value;
  }
}

module.exports = {
  mergeUnits,
  ensureCachedRepos,
  normalizeItalics,
  insertMissingPageLabels,
  TestEngine,
  readTestUnits,
}

