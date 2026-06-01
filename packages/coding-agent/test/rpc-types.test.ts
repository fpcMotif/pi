import { describe, expect, it } from "vitest";
import * as rpcTypes from "../src/modes/rpc/rpc-types.js";

describe("rpc-types module", () => {
	it("is a pure type-only module with no runtime exports", () => {
		expect(Object.keys(rpcTypes)).toEqual([]);
	});
});
