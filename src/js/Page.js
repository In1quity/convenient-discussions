/**
 * Page class.
 *
 * @module Page
 */

import CdError from './CdError';
import cd from './cd';
import { findFirstTimestamp, hideHtmlComments } from './wikitext';
import { firstCharToUpperCase, handleApiReject, underlinesToSpaces } from './util';
import { makeRequestNoTimers, parseCode, unknownApiErrorText } from './apiWrappers';
import { parseTimestamp } from './timestamp';

/**
 * Class representing a page. It contains a few properties and methods compared to {@link
 * module:Comment Comment} and {@link module:Section Section}.
 *
 * @module Page
 */
export default class Page {
  /**
   * Create a page instance.
   *
   * @param {string|mw.Title} name
   */
  constructor(name) {
    let title;
    if (name instanceof mw.Title) {
      title = name;

      /**
       * Page name, with a namespace name. The word separator is a space, not an underline, as in
       *   `mediawiki.Title`.
       *
       * @type {number}
       */
      this.name = mw.config.get('wgFormattedNamespaces')[title.namespace] + ':' + this.title;

    } else {
      title = mw.Title.newFromText(firstCharToUpperCase(name));
      this.name = underlinesToSpaces(name);
    }

    /**
     * Page title, with no namespace name. The word separator is a space, not an underline, as in
     *   `mediawiki.Title`.
     *
     * @type {number}
     */
    this.title = underlinesToSpaces(title.title);

    /**
     * Namespace number.
     *
     * @type {number}
     */
    this.namespace = title.namespace;

    /**
     * Page fragment (the part after `#`).
     *
     * @type {?string}
     */
    this.fragment = title.fragment;
  }

  /**
   * Get a URL of the page with the specified parameters.
   *
   * @param {object} parameters
   * @returns {string}
   */
  getUrl(parameters) {
    return mw.util.getUrl(this.name, parameters);
  }

  /**
   * Make a revision request (see {@link https://www.mediawiki.org/wiki/API:Revisions}) to load the
   * code of the specified page, together with a few revision properties: a timestamp, redirect
   * target, and query timestamp (curtimestamp). Enrich the page instance with those properties.
   * Also set the realName property that indicates either the redirect target if it's present or the
   * page name.
   *
   * @throws {CdError}
   */
  async getCode() {
    // The page doesn't exist.
    if (!mw.config.get('wgArticleId')) {
      return { code: '' };
    }

    const resp = await cd.g.api.get({
      action: 'query',
      titles: this.name,
      prop: 'revisions',
      rvprop: ['ids', 'content'],
      redirects: true,
      curtimestamp: true,
      formatversion: 2,
    }).catch(handleApiReject);

    const query = resp.query;
    const page = query && query.pages && query.pages[0];
    const revision = page && page.revisions && page.revisions[0];

    if (!query || !page) {
      throw new CdError({
        type: 'api',
        code: 'noData',
      });
    }
    if (page.missing) {
      throw new CdError({
        type: 'api',
        code: 'missing',
      });
    }
    if (page.invalid) {
      throw new CdError({
        type: 'api',
        code: 'invalid',
      });
    }
    if (!revision) {
      throw new CdError({
        type: 'api',
        code: 'noData',
      });
    }

    const redirectTarget = query.redirects && query.redirects[0] && query.redirects[0].to;

    /**
     * Page ID on the wiki. Filled upon running {@link module:Page#getCode} or {@link
     * module:Page#edit}. In the latter case, it is useful for newly created pages.
     *
     * @name pageId
     * @type {number|undefined}
     * @instance module:Page
     */

    /**
     * Page code. Filled upon running {@link module:Page#getCode}.
     *
     * @name code
     * @type {string|undefined}
     * @instance module:Page
     */

    /**
     * ID of the revision that has {@link module:Page#code}. Filled upon running {@link
     * module:Page#getCode}.
     *
     * @name revisionId
     * @type {string|undefined}
     * @instance module:Page
     */

    /**
     * Page where {@link module:Page#name} redirects. Filled upon running {@link
     * module:Page#getCode}.
     *
     * @name redirectTarget
     * @type {string|undefined}
     * @instance module:Page
     */

    /**
     * If {@link module:Page#name} redirects to some other page, the value is that page. If not, the
     * value is the same as {@link module:Page#name}. Filled upon running {@link
     * module:Page#getCode}.
     *
     * @name realName
     * @type {string|undefined}
     * @instance module:Page
     */

    /**
     * Time when {@link module:Page#code} was queried (as the server reports it). Filled upon
     * running {@link module:Page#getCode}.
     *
     * @name queryTimestamp
     * @type {string|undefined}
     * @instance module:Page
     */

    Object.assign(this, {
      pageId: page.pageid,

      // It's more convenient to unify regexps to have \n as the last character of anything, not
      // (?:\n|$), and it doesn't seem to affect anything substantially.
      code: revision.content + '\n',

      revisionId: revision.revid,
      redirectTarget,
      realName: redirectTarget || this.name,
      queryTimestamp: resp.curtimestamp,
    });
  }

  /**
   * Make a parse request (see {@link https://www.mediawiki.org/wiki/API:Parsing_wikitext}).
   *
   * @param {object} [options={}]
   * @param {boolean} [options.noTimers=false] Don't use timers (they can set the process on hold in
   *   background tabs if the browser throttles them).
   * @param {boolean} [options.markAsRead=false] Mark the current page as read in the watchlist.
   * @returns {object}
   * @throws {CdError}
   */
  async parse({
    noTimers = false,
    markAsRead = false,
  } = {}) {
    const params = {
      action: 'parse',

      // If we know that this page is a redirect, use its target. Otherwise, use the regular name.
      page: this.realName || this.name,

      prop: ['text', 'revid', 'modules', 'jsconfigvars'],
      formatversion: 2,
    };
    const request = noTimers ?
      makeRequestNoTimers(params).catch(handleApiReject) :
      cd.g.api.get(params).catch(handleApiReject);

    if (markAsRead) {
      $.get(this.getUrl());
    }
    const resp = await request;

    if (resp.parse === undefined) {
      throw new CdError({
        type: 'api',
        code: 'noData',
      });
    }

    return resp.parse;
  }

  /**
   * Modify page code string in accordance with an action. The `'addSection'` action is presumed.
   *
   * @param {string} pageCode
   * @param {object} options
   * @param {string} [options.commentForm]
   * @returns {string}
   */
  modifyCode(pageCode, { commentForm }) {
    const { commentCode } = commentForm.commentTextToCode('submit');

    let newPageCode;
    let codeBeforeInsertion;
    if (commentForm.isNewTopicOnTop) {
      const adjustedPageCode = hideHtmlComments(pageCode);
      const firstSectionStartIndex = adjustedPageCode.search(/^(=+).*?\1/m);
      codeBeforeInsertion = pageCode.slice(0, firstSectionStartIndex);
      const codeAfterInsertion = pageCode.slice(firstSectionStartIndex);
      newPageCode = codeBeforeInsertion + commentCode + '\n' + codeAfterInsertion;
    } else {
      codeBeforeInsertion = (pageCode + '\n').trimStart();
      newPageCode = codeBeforeInsertion + commentCode;
    }

    return { newPageCode, codeBeforeInsertion, commentCode };
  }

  /**
   * Make an edit API request ({@link https://www.mediawiki.org/wiki/API:Edit}).
   *
   * @param {object} options
   * @returns {number} editTimestamp
   */
  async edit(options) {
    let resp;
    try {
      resp = await cd.g.api.postWithEditToken(cd.g.api.assertCurrentUser(Object.assign(options, {
        // If we know that this page is a redirect, use its target. Otherwise, use the regular name.
        title: this.realName || this.name,

        action: 'edit',
        formatversion: 2,
      }))).catch(handleApiReject);
    } catch (e) {
      if (e instanceof CdError) {
        const { type, apiData } = e.data;
        if (type === 'network') {
          throw e;
        } else {
          const error = apiData && apiData.error;
          let message;
          let isRawMessage = false;
          let logMessage;
          let code;
          if (error) {
            code = error.code;
            switch (code) {
              case 'spamblacklist': {
                message = cd.s('error-spamblacklist', error.spamblacklist.matches[0]);
                break;
              }

              case 'titleblacklist': {
                message = cd.s('error-titleblacklist');
                break;
              }

              case 'abusefilter-warning':
              case 'abusefilter-disallowed': {
                await cd.g.api.loadMessagesIfMissing([code]);
                const description = mw.message(code, error.abusefilter.description).plain();
                ({ html: message } = await parseCode(description) || {});
                if (message) {
                  isRawMessage = true;
                } else {
                  message = cd.s('error-abusefilter', error.abusefilter.description);
                }
                break;
              }

              case 'editconflict': {
                message = cd.s('error-editconflict');
                break;
              }

              case 'blocked': {
                message = cd.s('error-blocked');
                break;
              }

              case 'missingtitle': {
                message = cd.s('error-pagedeleted');
                break;
              }

              default: {
                message = (
                  cd.s('error-pagenotedited') +
                  ' ' +
                  (await unknownApiErrorText(code, error.info))
                );
              }
            }

            logMessage = [code, apiData];
          } else {
            logMessage = apiData;
          }

          throw new CdError({
            type: 'api',
            code: 'error',
            apiData: resp,
            details: { code, message, isRawMessage, logMessage },
          });
        }
      } else {
        throw e;
      }
    }

    this.pageId = resp.edit.pageid;

    return resp.edit.newtimestamp;
  }

  /**
   * Enrich the page instance with the properties regarding whether new topics go on top on this
   * page (based on the various factors) and, if new topics are on top, the start index of the first
   * section.
   *
   * @throws {CdError}
   */
  analyzeNewTopicPlacement() {
    if (this.code === undefined) {
      throw new CdError('Can\'t analyze if the new topics are on top: Page#code is undefined.');
    }

    let areNewTopicsOnTop;
    if (cd.config.areNewTopicsOnTop) {
      areNewTopicsOnTop = cd.config.areNewTopicsOnTop(this.name, this.code);
    }

    const adjustedCode = hideHtmlComments(this.code);
    const sectionHeadingRegexp = /^==[^=].*?==[ \t]*(?:<!--[^]*?-->[ \t]*)*\n/gm;
    let firstSectionStartIndex;
    let sectionHeadingMatch;

    // Search for the first section's index. If areNewTopicsOnTop is true, we don't need it.
    if (areNewTopicsOnTop !== false) {
      sectionHeadingMatch = sectionHeadingRegexp.exec(adjustedCode);
      firstSectionStartIndex = sectionHeadingMatch.index;
      sectionHeadingRegexp.lastIndex = 0;
    }

    if (areNewTopicsOnTop === undefined) {
      // Detect the topic order: newest first or newest last.
      cd.debug.startTimer('areNewTopicsOnTop');
      let previousDate;
      let difference = 0;
      while ((sectionHeadingMatch = sectionHeadingRegexp.exec(adjustedCode))) {
        const timestamp = findFirstTimestamp(this.code.slice(sectionHeadingMatch.index));
        const { date } = timestamp && parseTimestamp(timestamp) || {};
        if (date) {
          if (previousDate) {
            difference += date > previousDate ? -1 : 1;
          }
          previousDate = date;
        }
      }
      areNewTopicsOnTop = difference === 0 ? this.namespace % 2 === 0 : difference > 0;
      cd.debug.logAndResetTimer('areNewTopicsOnTop');
    }

    /**
     * Whether new topics go on top on this page. Filled upon running {@link
     * module:Page#analyzeNewTopicPlacement}.
     *
     * @name areNewTopicsOnTop
     * @type {boolean|undefined}
     * @instance module:Page
     */

    /**
     * The start index of the first section, if new topics are on top on this page. Filled upon
     * running {@link module:Page#analyzeNewTopicPlacement}.
     *
     * @name firstSectionStartIndex
     * @type {number|undefined}
     * @instance module:Page
     */
    Object.assign(this, { areNewTopicsOnTop, firstSectionStartIndex });
  }
}
