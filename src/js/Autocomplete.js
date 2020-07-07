/**
 * Autocomplete mechanism.
 *
 * @module autocomplete
 */

import Tribute from '../../misc/tribute';
import cd from './cd';
import { defined, firstCharToUpperCase, removeDuplicates } from './util';
import {
  getRelevantPageNames,
  getRelevantTemplateNames,
  getRelevantUserNames,
} from './apiWrappers';

/**
 * Autocomplete class.
 */
export default class Autocomplete {
  /**
   * @typedef {object} OoUiTextInputWidget
   * @see https://doc.wikimedia.org/oojs-ui/master/js/#!/api/OO.ui.TextInputWidget
   */

  /**
   * Create an autocomplete instance. An instance is a set of settings and inputs to which these
   * settings apply.
   *
   * @param {object} options
   * @param {string[]} options.types Can contain `'mentions'`, `'wikilinks'`, `'templates'`, and
   *   `'tags'`.
   * @param {OoUiTextInputWidget[]} options.inputs Inputs to attach the autocomplete to.
   * @param {string[]} [options.defaultUserNames] Default list of user names for the mentions
   *   autocomplete.
   */
  constructor({ types, inputs, defaultUserNames }) {
    const collections = this.getCollections(types, defaultUserNames);

    require('../../misc/tribute.css');

    /**
     * {@link https://github.com/zurb/tribute Tribute} object.
     *
     * @type {Tribute}
     */
    this.tribute = new Tribute({
      collection: collections,
      allowSpaces: true,
      menuItemLimit: 10,
      noMatchTemplate: () => null,
      containerClass: 'tribute-container cd-mentionsContainer',
    });

    // Replace the native function, removing:
    // * "space" - it causes the menu not to change or hide when a space was typed;
    // * "delete" - it causes the menu not to appear when backspace is pressed and a character
    // preventing the menu to appear is removed (for example, ">" in "<small>"). It is
    // replaced with "e.keyCode === 8" in shouldDeactivate lower.
    this.tribute.events.constructor.keys = () => [
      {
        key: 9,
        value: 'TAB'
      },
      {
        key: 13,
        value: 'ENTER'
      },
      {
        key: 27,
        value: 'ESCAPE'
      },
      {
        key: 38,
        value: 'UP'
      },
      {
        key: 40,
        value: 'DOWN'
      }
    ];

    // This hack fixes the disappearing of the menu when a part of mention is typed and the
    // user presses any command key.
    this.tribute.events.shouldDeactivate = (e) => {
      if (!this.tribute.isActive) return false;

      return (
        // Backspace
        e.keyCode === 8 ||
        // Page Up, Page Down, End, Home, Left
        (e.keyCode >= 33 && e.keyCode <= 37) ||
        // Right
        e.keyCode === 39 ||
        // Ctrl+...
        (e.ctrlKey && e.keyCode !== 17) ||
        // ⌘+...
        (e.metaKey && (e.keyCode !== 91 && e.keyCode !== 93 && e.keyCode !== 224))
      );
    };

    inputs.forEach((input) => {
      const element = input.$input.get(0);
      this.tribute.attach(element);
      element.cdInput = input;
      element.addEventListener('tribute-replaced', (e) => {
        // Move the caret to the place we need and remove the space that is always included
        // after the inserted text (the native mechanism to get rid of this space is buggy).
        const cursorIndex = input.getRange().to;
        const value = input.getValue();
        input.setValue(value.slice(0, cursorIndex - 1) + value.slice(cursorIndex));
        input.selectRange(cursorIndex - 1 - e.detail.item.original.endOffset);
      });
    });
  }

  /**
   * Get a list of collection of specified types.
   *
   * @param {string[]} types
   * @param {string[]} defaultUserNames
   * @returns {object[]}
   */
  getCollections(types, defaultUserNames) {
    const selectTemplate = (item) => {
      if (item) {
        return item.original.value;
      } else {
        return '';
      }
    };

    const prepareValues = (arr, config) => (
      removeDuplicates(arr)
        .filter(defined)
        .map((item) => ({
          key: Array.isArray(item) ? item[0] : item,
          value: config.transform ? config.transform(item) : item,
          endOffset: config.getEndOffset ? config.getEndOffset(item) : 0,
        }))
    );

    const collectionsByType = {
      mentions: {
        trigger: '@',
        searchOpts: {
          skip: true,
        },
        requireLeadingSpace: true,
        selectTemplate,
        values: async (text, callback) => {
          // Fix multiple event firing (we need it after fixing currentMentionTextSnapshot below).
          if (text && this.mentions.snapshot === text) return;

          if (!text.startsWith(this.mentions.snapshot)) {
            this.mentions.cache = [];
          }
          this.mentions.snapshot = text;

          // Hack to make the menu disappear when a space is typed after "@".
          this.tribute.currentMentionTextSnapshot = {};

          if (text.includes('[[')) {
            callback([]);
            return;
          }

          if (this.mentions.byText[text]) {
            callback(prepareValues(this.mentions.byText[text], this.mentions));
          } else {
            const matches = Autocomplete.search(text, this.mentions.default);
            let values = matches.slice();

            const isLikelyName = (
              text &&
              text.length <= 85 &&
              !/[#<>[\]|{}/@:]/.test(text) &&
              // 5 spaces in a user name seems too many. "Jack who built the house" has 4 :-)
              (text.match(/ /g) || []).length <= 4
            );
            if (isLikelyName) {
              // Logically, matched or this.mentions.cache should have zero length (a request is made only
              // if there is no matches in the section; if there are, this.mentions.cache is an empty
              // array).
              if (!matches.length) {
                values.push(...this.mentions.cache);
              }
              values = Autocomplete.search(text, values);

              // Make the typed text always appear on the last, 10th place.
              values[9] = text.trim();
            }

            callback(prepareValues(values, this.mentions));

            if (isLikelyName && !matches.length) {
              let values;
              try {
                values = await getRelevantUserNames(text);
              } catch (e) {
                return;
              }

              values = this.mentions.removeSelf(values);
              this.mentions.cache = values.slice();

              // Make the typed text always appear on the last, 10th place.
              values[9] = text.trim();

              this.mentions.byText[text] = values;

              // The text has been updated since the request was made.
              if (this.mentions.snapshot !== text) return;

              callback(prepareValues(values, this.mentions));
            }
          }
        },
      },
      wikilinks: {
        trigger: '[[',
        searchOpts: {
          skip: true,
        },
        selectTemplate,
        values: async (text, callback) => {
          if (cd.g.COLON_NAMESPACES_PREFIX_REGEXP.test(text)) {
            text = text.slice(1);
          }

          if (!text.startsWith(this.wikilinks.snapshot)) {
            this.wikilinks.cache = [];
          }
          this.wikilinks.snapshot = text;

          if (text.includes('[[')) {
            callback([]);
            return;
          }

          if (this.wikilinks.byText[text]) {
            callback(prepareValues(this.wikilinks.byText[text], this.wikilinks));
          } else {
            let values = [];
            const isLikelyName = (
              text &&
              text.length <= 255 &&
              !/[#<>[\]|{}]/.test(text) &&
              (!/^:/.test(text) || cd.g.COLON_NAMESPACES_PREFIX_REGEXP.test(text)) &&
              // 10 spaces in a page name seems too many.
              (text.match(/ /g) || []).length <= 9
            );
            if (isLikelyName) {
              values.push(...this.wikilinks.cache);
              values = Autocomplete.search(text, values);

              // Make the typed text always appear on the last, 10th place.
              values[9] = text.trim();
            }

            callback(prepareValues(values, this.wikilinks));

            if (isLikelyName) {
              let values;
              try {
                values = await getRelevantPageNames(text);
              } catch (e) {
                return;
              }

              this.wikilinks.cache = values.slice();

              // Make the typed text always appear on the last, 10th place.
              values[9] = text.trim();

              this.wikilinks.byText[text] = values;

              // The text has been updated since the request was made.
              if (this.wikilinks.snapshot !== text) return;

              callback(prepareValues(values, this.wikilinks));
            }
          }
        },
      },
      templates: {
        trigger: '{{',
        searchOpts: {
          skip: true,
        },
        selectTemplate: (item) => {
          if (item) {
            const input = this.tribute.current.element.cdInput;

            input.setDisabled(true);
            input.pushPending();

            cd.g.api.get({
              action: 'templatedata',
              titles: `Template:${item.original.key}`,
              redirects: true,
            })
              .then(
                (resp) => {
                  const pages = resp && resp.pages;
                  let s = '';
                  let firstValueIndex = 0;
                  Object.keys(pages).forEach((key) => {
                    const template = pages[key];
                    const params = template.params || [];
                    const paramNames = template.paramOrder || Object.keys(params);
                    paramNames
                      .filter((param) => params[param].required || params[param].suggested)
                      .forEach((param) => {
                        if (template.format === 'block') {
                          s += `\n| ${param} = `;
                        } else {
                          if (isNaN(param)) {
                            s += `|${param}=`;
                          } else {
                            s += `|`;
                          }
                        }
                        if (!firstValueIndex) {
                          firstValueIndex = s.length;
                        }
                      });
                    if (template.format === 'block' && s) {
                      s += '\n';
                    }
                  });

                  const cursorIndex = input.getRange().to;
                  const value = input.getValue();
                  input.setValue(value.slice(0, cursorIndex) + s + value.slice(cursorIndex));
                  input.selectRange(cursorIndex + firstValueIndex);
                },
                (e) => {
                  mw.notify(e, { type: 'error' })
                }
              )
              .always(() => {
                input.setDisabled(false);
                input.popPending();
                input.focus();
              });

            return item.original.value;
          } else {
            return '';
          }
        },
        values: async (text, callback) => {
          if (!text.startsWith(this.templates.snapshot)) {
            this.templates.cache = [];
          }
          this.templates.snapshot = text;

          if (text.includes('{{')) {
            callback([]);
            return;
          }

          if (this.templates.byText[text]) {
            callback(prepareValues(this.templates.byText[text], this.templates));
          } else {
            let values = [];
            const isLikelyName = (
              text &&
              text.length <= 255 &&
              !/[#<>[\]|{}]/.test(text) &&
              // 10 spaces in a page name seems too many.
              (text.match(/ /g) || []).length <= 9
            );
            if (isLikelyName) {
              values.push(...this.templates.cache);
              values = Autocomplete.search(text, values);

              // Make the typed text always appear on the last, 10th place.
              values[9] = text.trim();
            }

            callback(prepareValues(values, this.templates));

            if (isLikelyName) {
              let values;
              try {
                values = await getRelevantTemplateNames(text);
              } catch (e) {
                return;
              }

              this.templates.cache = values.slice();

              // Make the typed text always appear on the last, 10th place.
              values[9] = text.trim();

              this.templates.byText[text] = values;

              // The text has been updated since the request was made.
              if (this.templates.snapshot !== text) return;

              callback(prepareValues(values, this.templates));
            }
          }
        },
      },
      tags: {
        trigger: '<',
        menuShowMinLength: 1,
        searchOpts: {
          skip: true,
        },
        selectTemplate,
        values: (text, callback) => {
          const regexp = new RegExp('^' + mw.util.escapeRegExp(text), 'i');
          if (!/^[a-z]+$/i.test(text) && !this.tags.withSpace.some((tag) => regexp.test(tag))) {
            callback([]);
            return;
          }
          const matches = this.tags.default.filter((tag) => regexp.test(tag));
          callback(prepareValues(matches, this.tags));
        },
      },
    };

    const collections = [];
    types.forEach((type) => {
      this[type] = Autocomplete[`get${firstCharToUpperCase(type)}Config`]
        .call(null, type === 'mentions' ? defaultUserNames : undefined);
      collections.push(collectionsByType[type]);
    });

    return collections;
  }

  /**
   * Get mentions autocomplete configuration.
   *
   * @param {string[]} [defaultUserNames=[]]
   * @returns {object}
   */
  static getMentionsConfig(defaultUserNames = []) {
    const userNamespace = mw.config.get('wgFormattedNamespaces')[2];
    const config = {
      byText: {},
      cache: [],
      transform: (name) => {
        name = name.trim();
        return `@[[${userNamespace}:${name}|${name}]]`;
      },
      removeSelf: (arr) => {
        while (arr.includes(cd.g.CURRENT_USER_NAME)) {
          arr.splice(arr.indexOf(cd.g.CURRENT_USER_NAME), 1);
        }
        return arr;
      },
    };
    config.default = config.removeSelf(defaultUserNames);

    return config;
  }

  /**
   * Get wikilinks autocomplete configuration.
   *
   * @returns {object}
   */
  static getWikilinksConfig() {
    const colonNamespaces = mw.config.get('wgFormattedNamespaces');
    const colonNamespacesRegexp = new RegExp(
      `^(${colonNamespaces[6]}|${colonNamespaces[14]}):`,
      'i'
    );
    return {
      byText: {},
      cache: [],
      transform: (name) => {
        name = name.trim();
        if (colonNamespacesRegexp.test(name)) {
          name = ':' + name;
        }
        return `[[${name}]]`;
      },
    };
  }

  /**
   * Get templates autocomplete configuration.
   *
   * @returns {object}
   */
  static getTemplatesConfig() {
    return {
      byText: {},
      cache: [],
      transform: (name) => {
        name = name.trim();
        return `{{${name}}}`;
      },
      getEndOffset: () => 2,
    };
  }

  /**
   * Get tags autocomplete configuration.
   *
   * @returns {object}
   */
  static getTagsConfig() {
    const config = {
      default: [
        // See https://meta.wikimedia.org/wiki/Help:HTML_in_wikitext#Permitted_HTML,
        // https://en.wikipedia.org/wiki/Help:HTML_in_wikitext#Parser_and_extension_tags. Deprecated
        // tags are not included. An element can be an array of a string to display and a string to
        // insert, with "+" in the place where to put the caret.
        'abbr',
        'b',
        'bdi',
        'bdo',
        'blockquote',
        ['br', '<br>'],
        'caption',
        'cite',
        'code',
        ['codenowiki', '<code><nowiki>+</nowiki></code>'],
        'data',
        'dd',
        'del',
        'dfn',
        'div',
        'dl',
        'dt',
        'em',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        ['hr', '<hr>'],
        'i',
        'ins',
        'kbd',
        'li',
        'link',
        'mark',
        'meta',
        'ol',
        'p',
        'pre',
        'q',
        'rp',
        'rt',
        'rtc',
        'ruby',
        's',
        'samp',
        'small',
        'span',
        'strong',
        'sub',
        'sup',
        'table',
        'td',
        'th',
        'time',
        'tr',
        'u',
        'ul',
        'var',
        ['wbr', '<wbr>'],
        'gallery',
        'includeonly',
        'noinclude',
        'nowiki',
        'onlyinclude',
        'categorytree',
        'charinsert',
        'chem',
        'ce',
        'graph',
        'hiero',
        'imagemap',
        'indicator',
        'inputbox',
        'mapframe',
        'maplink',
        'math',
        'math chem',
        'poem',
        'ref',
        ['references', '<references />'],
        'score',
        'section',
        'syntaxhighlight',
        ['syntaxhighlight lang=""', '<syntaxhighlight lang="+"></syntaxhighlight>'],
        'templatedata',
        ['templatestyles', '<templatestyles src="+" />'],
        'timeline',
      ],
      transform: (item) => {
        if (Array.isArray(item)) {
          return item[1].replace(/\+/, '');
        } else {
          return `<${item}></${item}>`;
        }
      },
      getEndOffset: (item) => {
        if (Array.isArray(item)) {
          return item[1].includes('+') ? item[1].length - 1 - item[1].indexOf('+') : 0;
        } else {
          return item.length + 3;
        }
      },
    };
    config.default.sort();
    config.withSpace = config.default.filter((tag) => tag.includes(' '));

    return config;
  }

  /**
   * Search for a text in a list of values,.
   *
   * @param {string} text
   * @param {string[]} list
   * @returns {string[]} Matched results.
   */
  static search(text, list) {
    const containsRegexp = new RegExp(mw.util.escapeRegExp(text), 'i');
    const startsWithRegexp = new RegExp('^' + mw.util.escapeRegExp(text), 'i');
    return list
      .filter((item) => containsRegexp.test(item))
      .sort((item1, item2) => {
        const item1StartsWith = startsWithRegexp.test(item1);
        const item2StartsWith = startsWithRegexp.test(item2);
        if (item1StartsWith && !item2StartsWith) {
          return -1;
        } else if (item2StartsWith && !item1StartsWith) {
          return 1;
        } else {
          return 0;
        }
      });
  }
}
