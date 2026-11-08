/** The slice of speech-rule-engine (lib/sre.js, untyped) the read-aloud
 *  reference uses. */
declare module "speech-rule-engine" {
	interface SreFeatures {
		locale?: string;
		domain?: string;
		style?: string;
		modality?: string;
	}
	const SRE: {
		setupEngine(features: SreFeatures): Promise<void>;
		engineReady(): Promise<void>;
		toSpeech(mathml: string): string;
	};
	export default SRE;
}
