// Coordinator contract stub; executor B must replace before deployment.
export type ReviewText = { summary: string; details: string };
export function russianReviewInstruction(): string { throw new Error("Language module not implemented"); }
export function needsRussianTranslation(_review: ReviewText): boolean { throw new Error("Language module not implemented"); }
export function prepareRussianTranslation(_review: ReviewText): { prompt: string; parse(output: string): ReviewText | null } { throw new Error("Language module not implemented"); }
export function withTranslationFailureNotice(_review: ReviewText): ReviewText { throw new Error("Language module not implemented"); }
