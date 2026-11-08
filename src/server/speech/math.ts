/**
 * The formula reference for read-aloud (speech wave, 2026-11-08): every
 * formula in a tutor text, with SRE's MathSpeak reading as the structural
 * truth (fraction bounds, bracketing, exponents) the script model must
 * keep while it phrases the formula naturally. MathSpeak, not ClearSpeak:
 * the owner's German probe showed ClearSpeak misreading a binomial
 * coefficient as a "2 mal 1 Spaltenmatrize", while MathSpeak stayed exact.
 *
 * TeX → MathML via KaTeX (the renderer's own engine), MathML → speech via
 * SRE, entirely local. A formula SRE cannot read keeps an empty reference;
 * the model then reads the TeX alone.
 */

import katex from "katex";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";
import SRE from "speech-rule-engine";
import { transformMathDelimiters } from "../../core/math-delims.ts";

export interface FormulaReference {
	tex: string;
	display: boolean;
	/** SRE MathSpeak reading; "" when SRE could not read it. */
	reading: string;
}

/** SRE's shipped locales (lib/mathmaps), minus the non-language maps. */
const SRE_LOCALES = new Set(["af", "ca", "da", "de", "en", "es", "fr", "hi", "it", "ko", "nb", "nn", "sv"]);

/** The SRE locale for a dictation language code ("de-CH" → "de"); English
 *  when SRE has no map for it. */
export function sreLocale(language: string): string {
	const base = language.toLowerCase().split("-")[0] ?? "en";
	return SRE_LOCALES.has(base) ? base : "en";
}

type MdNode = { type: string; value?: string; children?: MdNode[] };

/** Every formula in reading order, de-duplicated (first occurrence wins). */
export function extractFormulas(markdown: string): Array<{ tex: string; display: boolean }> {
	const tree = fromMarkdown(transformMathDelimiters(markdown), {
		extensions: [math({ singleDollarTextMath: true })],
		mdastExtensions: [mathFromMarkdown()],
	}) as MdNode;
	const out: Array<{ tex: string; display: boolean }> = [];
	const seen = new Set<string>();
	const walk = (node: MdNode) => {
		if ((node.type === "math" || node.type === "inlineMath") && typeof node.value === "string") {
			const tex = node.value.trim();
			if (tex && !seen.has(tex)) {
				seen.add(tex);
				out.push({ tex, display: node.type === "math" });
			}
			return;
		}
		for (const child of node.children ?? []) walk(child);
	};
	walk(tree);
	return out;
}

function mathml(tex: string, display: boolean): string | null {
	try {
		const html = katex.renderToString(tex, { output: "mathml", displayMode: display, throwOnError: true });
		return html.match(/<math[\s\S]*<\/math>/)?.[0] ?? null;
	} catch {
		return null;
	}
}

// SRE's engine is process-global: setup + reading run strictly one batch
// at a time, so a concurrent batch can never switch the locale mid-read.
let queue: Promise<unknown> = Promise.resolve();

/** The formula references for one tutor text, read in `language`. */
export function formulaReferences(markdown: string, language: string): Promise<FormulaReference[]> {
	const formulas = extractFormulas(markdown);
	if (formulas.length === 0) return Promise.resolve([]);
	const run = queue.then(async () => {
		await SRE.setupEngine({ locale: sreLocale(language), domain: "mathspeak", modality: "speech" });
		await SRE.engineReady();
		return formulas.map(({ tex, display }) => {
			const ml = mathml(tex, display);
			let reading = "";
			if (ml) {
				try {
					reading = SRE.toSpeech(ml).trim();
				} catch {
					reading = "";
				}
			}
			return { tex, display, reading };
		});
	});
	queue = run.catch(() => {});
	return run;
}
