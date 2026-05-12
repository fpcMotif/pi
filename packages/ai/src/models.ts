// Re-export shim. The model registry data and synchronous utilities live in
// @earendil-works/pi-models after the ADR-0005 / ADR-0006 phase 1 carve-out.
// This file is kept so internal `../models.js` imports inside pi-ai continue
// to resolve unchanged; external consumers should import directly from
// "@earendil-works/pi-models".
export * from "@earendil-works/pi-models";
