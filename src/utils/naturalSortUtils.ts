function splitNaturalParts(value: string): string[] {
	return value.match(/\d+|\D+/g) ?? [value];
}

export function naturalCompare(left: string, right: string): number {
	const leftParts = splitNaturalParts(left);
	const rightParts = splitNaturalParts(right);
	const maxLen = Math.max(leftParts.length, rightParts.length);

	for (let idx = 0; idx < maxLen; idx++) {
		const leftPart = leftParts[idx];
		const rightPart = rightParts[idx];

		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;

		const leftIsNumber = /^\d+$/.test(leftPart);
		const rightIsNumber = /^\d+$/.test(rightPart);

		if (leftIsNumber && rightIsNumber) {
			const leftNormalized = leftPart.replace(/^0+/, "") || "0";
			const rightNormalized = rightPart.replace(/^0+/, "") || "0";

			if (leftNormalized.length !== rightNormalized.length) {
				return leftNormalized.length - rightNormalized.length;
			}

			if (leftNormalized !== rightNormalized) {
				return leftNormalized < rightNormalized ? -1 : 1;
			}

			if (leftPart.length !== rightPart.length) {
				return leftPart.length - rightPart.length;
			}

			continue;
		}

		if (leftPart !== rightPart) {
			return leftPart < rightPart ? -1 : 1;
		}
	}

	return 0;
}
