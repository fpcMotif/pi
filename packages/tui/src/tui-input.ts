export type InputListenerResult = { consume?: boolean; data?: string } | undefined;
export type InputListener = (data: string) => InputListenerResult;

export type InputListenerDispatchResult =
	| { readonly consume: true }
	| { readonly consume: false; readonly data: string };

export function applyInputListeners(data: string, listeners: Iterable<InputListener>): InputListenerDispatchResult {
	let current = data;
	for (const listener of listeners) {
		const result = listener(current);
		if (result?.consume) {
			return { consume: true };
		}
		if (result?.data !== undefined) {
			current = result.data;
		}
	}
	if (current.length === 0) {
		return { consume: true };
	}
	return { consume: false, data: current };
}

export type CellSizeResponse =
	| { readonly _tag: "valid"; readonly widthPx: number; readonly heightPx: number }
	| { readonly _tag: "invalid" };

export function parseCellSizeResponse(data: string): CellSizeResponse | undefined {
	const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
	if (!match) {
		return undefined;
	}

	const heightPx = parseInt(match[1], 10);
	const widthPx = parseInt(match[2], 10);
	if (heightPx <= 0 || widthPx <= 0) {
		return { _tag: "invalid" };
	}

	return { _tag: "valid", widthPx, heightPx };
}
