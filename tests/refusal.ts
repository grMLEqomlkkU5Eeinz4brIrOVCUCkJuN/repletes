import assert from "node:assert/strict";

import { RepletesError, type RepletesErrorCode } from "../src/index.js";

/**
 * Asserts a refusal is catchable as a repletes error and says which one, so a
 * renamed code fails here rather than silently in a consumer's catch block.
 */
export function refusal(code: RepletesErrorCode): (error: unknown) => true {
	return (error: unknown) => {
		assert.ok(
			error instanceof RepletesError,
			`expected a RepletesError, received ${String(error)}`
		);
		// Extending TypeError is part of the contract: code that catches the
		// platform error still catches ours.
		assert.ok(error instanceof TypeError);
		assert.equal(error.code, code);
		return true;
	};
}
