'use strict';

/**
 * Error helpers.
 *
 * @module error
 */

/**
 * @param {string} s
 * @return {Error}
 */
/* istanbul ignore next */
const create = s => new Error(s);

/**
 * @throws {Error}
 * @return {never}
 */
/* istanbul ignore next */
const methodUnimplemented = () => {
  throw create('Method unimplemented')
};

/**
 * @throws {Error}
 * @return {never}
 */
/* istanbul ignore next */
const unexpectedCase = () => {
  throw create('Unexpected case')
};

var error = /*#__PURE__*/Object.freeze({
  __proto__: null,
  create: create,
  methodUnimplemented: methodUnimplemented,
  unexpectedCase: unexpectedCase
});

exports.create = create;
exports.error = error;
exports.methodUnimplemented = methodUnimplemented;
exports.unexpectedCase = unexpectedCase;
///# sourceMappingURL=error-55a9a8c8.cjs.map