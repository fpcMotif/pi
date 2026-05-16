import { describe, expect, it } from "vitest";
import * as oauthBarrel from "../src/oauth.js";
import * as oauthTypes from "../src/utils/oauth/types.js";
import * as providerTypes from "../src/types.js";

// src/types.ts is the package's public type surface: interfaces and type
// aliases only. It must compile away at runtime apart from the value re-exports
// it forwards. Importing it here makes coverage measure the file instead of
// skipping it as unloaded.
describe("type-only modules", () => {
	it("src/types.ts exposes no runtime values of its own", () => {
		// types.ts re-exports `export type *` from pi-models and a handful of
		// local `export type` aliases; nothing in it is a runtime value.
		expect(Object.keys(providerTypes)).toEqual([]);
	});

	it("src/utils/oauth/types.ts is a pure type-only module", () => {
		expect(Object.keys(oauthTypes)).toEqual([]);
	});

	it("src/oauth.ts re-exports the oauth utils barrel", () => {
		// oauth.ts is `export * from "./utils/oauth/index.js"`. It must surface
		// the provider-registry runtime functions.
		expect(typeof oauthBarrel.getOAuthProvider).toBe("function");
		expect(typeof oauthBarrel.registerOAuthProvider).toBe("function");
		expect(typeof oauthBarrel.getOAuthProviders).toBe("function");
		expect(typeof oauthBarrel.refreshOAuthToken).toBe("function");
		expect(typeof oauthBarrel.getOAuthApiKey).toBe("function");
		expect(typeof oauthBarrel.openaiCodexOAuthProvider).toBe("object");
	});
});
