// Re-export shim. The image-model registry moved to @earendil-works/pi-models
// during the ADR-0005 / ADR-0006 phase 1 carve-out.
export {
	getImageModel,
	getImageModels,
	getImageProviders,
	IMAGE_MODELS,
} from "@earendil-works/pi-models";
