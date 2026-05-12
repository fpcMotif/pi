# Changelog

## [Unreleased]

### Added

- Initial extraction from `@earendil-works/pi-ai` (ADR-0005, ADR-0006 phase 1). Pure model-registry data + synchronous utilities (`getModel`, `getProviders`, `getModels`, `calculateCost`, `getSupportedThinkingLevels`, `clampThinkingLevel`, `modelsAreEqual`) for text and image models. No Effect or provider runtime dependencies; browser-safe.
