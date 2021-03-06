/**
 * User options handling functions.
 *
 * @module options
 */

import lzString from 'lz-string';

import CdError from './CdError';
import cd from './cd';
import { getUserInfo, setGlobalOption, setLocalOption } from './apiWrappers';

/**
 * Pack the visits object into a string for further compression.
 *
 * @param {object} visits
 * @returns {string}
 */
export function packVisits(visits) {
  return Object.keys(visits)
    .map((key) => `${key},${visits[key].join(',')}\n`)
    .join('')
    .trim();
}

/**
 * Unpack the visits string into a visits object.
 *
 * @param {string} visitsString
 * @returns {object}
 */
export function unpackVisits(visitsString) {
  const visits = {};
  // " *" fixes a error previously made. Not needed for new sites.
  const regexp = /^(\d+), *(.+)$/gm;
  let match;
  while ((match = regexp.exec(visitsString))) {
    visits[match[1]] = match[2].split(',');
  }
  return visits;
}

/**
 * Pack the watched sections object into a string for further compression.
 *
 * @param {object} watchedSections
 * @returns {string}
 */
export function packWatchedSections(watchedSections) {
  return Object.keys(watchedSections).filter((pageId) => watchedSections[pageId].length)
    .map((key) => ` ${key} ${watchedSections[key].join('\n')}\n`)
    .join('')
    .trim();
}

/**
 * Unpack the watched sections string into a visits object.
 *
 * @param {string} watchedSectionsString
 * @returns {object}
 */
export function unpackWatchedSections(watchedSectionsString) {
  const watchedSections = {};
  const pages = watchedSectionsString.split(/(?:^|\n )(\d+) /).slice(1);
  let pageId;
  for (
    let i = 0, isPageId = true;
    i < pages.length;
    i++, isPageId = !isPageId
  ) {
    if (isPageId) {
      pageId = pages[i];
    } else {
      watchedSections[pageId] = pages[i].split('\n');
    }
  }
  return watchedSections;
}

/**
 * Request the settings from the server.
 *
 * @param {boolean} [reuse=false]
 * @returns {object}
 */
export async function getSettings(reuse = false) {
  const { options } = await getUserInfo(reuse);

  let settings;
  try {
    settings = JSON.parse(options[cd.g.SETTINGS_OPTION_FULL_NAME]) || {};
  } catch (e) {
    settings = cd.settings;
  }
  return settings;
}

/**
 * Save the settings to the server. This function will split the settings into the global and local
 * ones and make two respective requests.
 *
 * @param {object} [settings]
 */
export async function setSettings(settings) {
  settings = settings || cd.settings;
  const globalSettings = {};
  const localSettings = {};
  Object.keys(settings).forEach((key) => {
    if (cd.localSettingNames.includes(key)) {
      localSettings[key] = settings[key];
    } else {
      globalSettings[key] = settings[key];
    }
  });

  try {
    await Promise.all([
      setLocalOption(cd.g.LOCAL_SETTINGS_OPTION_FULL_NAME, JSON.stringify(localSettings)),
      setGlobalOption(cd.g.SETTINGS_OPTION_FULL_NAME, JSON.stringify(globalSettings))
    ]);
  } catch (e) {
    // The site doesn't support global preferences.
    if (e instanceof CdError && e.data.apiData && e.data.apiData.error.code === 'badvalue') {
      setLocalOption(cd.g.SETTINGS_OPTION_FULL_NAME, JSON.stringify(globalSettings));
    } else {
      throw e;
    }
  }
}

/**
 * @typedef {object} GetVisitsReturn
 * @property {object} visits
 * @property {object} thisPageVisits
 */

/**
 * Request the pages visits data from the server.
 *
 * `mw.user.options` is not used even on first run because the script may not run immediately after
 * the page is loaded. In fact, when the page is loaded in a background tab, it can be throttled
 * until it is focused, so an indefinite amount of time can pass.
 *
 * @param {boolean} [reuse=false]
 * @returns {GetVisitsReturn}
 */
export async function getVisits(reuse = false) {
  const visits = await (
    cd.g.firstRun && mw.user.options.get(cd.g.VISITS_OPTION_FULL_NAME) === null ?
    Promise.resolve({}) :
    getUserInfo(reuse).then((options) => options.visits)
  );
  const articleId = mw.config.get('wgArticleId');
  let thisPageVisits;
  // This should always true; this check should be performed before.
  if (articleId) {
    visits[articleId] = visits[articleId] || [];
    thisPageVisits = visits[articleId];
  }

  // These variables are not used anywhere in the script but can be helpful for testing purposes.
  cd.g.visits = visits;
  cd.g.thisPageVisits = thisPageVisits;

  return { visits, thisPageVisits };
}

/**
 * Remove the oldest 10% of visits when the size limit is hit.
 *
 * @param {object} originalVisits
 * @returns {object}
 * @private
 */
function cleanUpVisits(originalVisits) {
  const visits = Object.assign({}, originalVisits);
  const timestamps = Object.keys(visits).reduce((acc, key) => acc.concat(visits[key]), []);
  timestamps.sort();
  const boundary = timestamps[Math.floor(timestamps.length / 10)];
  Object.keys(visits).forEach((key) => {
    visits[key] = visits[key].filter((visit) => visit >= boundary);
    if (!visits[key].length) {
      delete visits[key];
    }
  });
  return visits;
}

/**
 * Save the pages visits data to the server.
 *
 * @param {object} visits
 */
export async function setVisits(visits) {
  if (!visits) return;

  const visitsString = packVisits(visits);
  const visitsStringCompressed = lzString.compressToEncodedURIComponent(visitsString);
  try {
    await setLocalOption(cd.g.VISITS_OPTION_FULL_NAME, visitsStringCompressed);
  } catch (e) {
    if (e instanceof CdError) {
      const { type, code } = e.data;
      if (type === 'internal' && code === 'sizeLimit') {
        setVisits(cleanUpVisits(visits));
      } else {
        console.error(e);
      }
    } else {
      console.error(e);
    }
  }
}

/**
 * Request the watched sections from the server and assign them to
 * `convenientDiscussions.g.watchedSections`.
 *
 * `mw.user.options` is not used even on first run because it appears to be cached sometimes which
 * can be critical for determining watched sections.
 *
 * @param {boolean} [reuse=false]
 * @param {object} [keptData={}]
 * @param {string} [keptData.justWatchedSection]
 * @param {string} [keptData.justUnwatchedSection]
 */
export async function getWatchedSections(reuse = false, keptData = {}) {
  const watchedSections = await (
    cd.g.firstRun && mw.user.options.get(cd.g.WATCHED_SECTIONS_OPTION_FULL_NAME) === null ?
    Promise.resolve({}) :
    getUserInfo(reuse).then((options) => options.watchedSections)
  );

  const articleId = mw.config.get('wgArticleId');
  let thisPageWatchedSections;
  if (articleId) {
    watchedSections[articleId] = watchedSections[articleId] || [];
    thisPageWatchedSections = watchedSections[articleId];

    // Manually add/remove a section that was added/removed at the same moment the page was
    // reloaded the last time, so when we requested watched sections from server, this section
    // wasn't there yet most probably.
    if (keptData.justWatchedSection) {
      if (!thisPageWatchedSections.includes(keptData.justWatchedSection)) {
        thisPageWatchedSections.push(keptData.justWatchedSection);
      }
    }
    if (keptData.justUnwatchedSection) {
      if (thisPageWatchedSections.includes(keptData.justUnwatchedSection)) {
        thisPageWatchedSections
          .splice(thisPageWatchedSections.indexOf(keptData.justUnwatchedSection), 1);
      }
    }
  }

  cd.g.watchedSections = watchedSections;
  cd.g.thisPageWatchedSections = thisPageWatchedSections;
}

/**
 * Save the watched sections kept in `convenientDiscussions.g.watchedSections` to the server.
 */
export function setWatchedSections() {
  const watchedSectionsString = packWatchedSections(cd.g.watchedSections);
  const watchedSectionsStringCompressed = (
    lzString.compressToEncodedURIComponent(watchedSectionsString)
  );
  setLocalOption(cd.g.WATCHED_SECTIONS_OPTION_FULL_NAME, watchedSectionsStringCompressed);
}
