"use client";

/**
 * Settings → Read aloud (speech wave, 2026-11-08): the automatic-reading
 * switch, the voice (with a preview), the tempo and the speaking
 * instruction. Every commit is one whole-section PUT through the dialog's
 * writer. The switch needs the OpenAI key (script + voice both run on it).
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import {
	DEFAULT_SPEECH_INSTRUCTIONS, FACTORY_SETTINGS, SPEECH_INSTRUCTIONS_MAX, SPEECH_SPEED_MAX, SPEECH_SPEED_MIN, SPEECH_VOICES,
	type SpeechSettings, type SpeechVoice,
} from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";
import { SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

function useOpenAIKeyPresent(): boolean | null {
	const [present, setPresent] = useState<boolean | null>(null);
	const read = () => {
		void fetch("/api/keys")
			.then((res) => (res.ok ? (res.json() as Promise<{ keys?: Array<{ id: string; present: boolean }> }>) : null))
			.then((body) => setPresent(Boolean(body?.keys?.some((k) => k.id === "OPENAI_API_KEY" && k.present))))
			.catch(() => setPresent(false));
	};
	useEffect(read, []);
	useSettingsSaved((section) => {
		if (section === "keys") read();
	});
	return present;
}

export function SpeechSection({
	speech,
	onSectionChange,
	onOpenKeys,
}: {
	speech: SpeechSettings | undefined;
	onSectionChange: (next: SpeechSettings) => void;
	onOpenKeys: () => void;
}) {
	const current = { ...FACTORY_SETTINGS.speech, ...speech };
	const keyPresent = useOpenAIKeyPresent();
	const write = (patch: Partial<SpeechSettings>) => onSectionChange({ ...(speech ?? {}), ...patch });

	// Tempo: the slider moves locally; the PUT lands on release.
	const [speedDraft, setSpeedDraft] = useState<number | null>(null);
	const speed = speedDraft ?? current.speed;
	const commitSpeed = () => {
		if (speedDraft !== null && speedDraft !== current.speed) write({ speed: speedDraft });
		setSpeedDraft(null);
	};

	const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
	const instructions = instructionsDraft ?? current.instructions;

	// Voice preview: one sample sentence in the chosen voice + instruction.
	const [previewing, setPreviewing] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const previewAudio = useRef<HTMLAudioElement | null>(null);
	useEffect(() => () => previewAudio.current?.pause(), []);
	const preview = async () => {
		setPreviewing(true);
		setPreviewError(null);
		try {
			const res = await fetch("/api/speech/preview", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ voice: current.voice, instructions }),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(detail?.message ?? `Preview failed (${res.status}).`);
			}
			const url = URL.createObjectURL(await res.blob());
			previewAudio.current?.pause();
			const audio = new Audio(url);
			audio.playbackRate = speed;
			audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
			previewAudio.current = audio;
			await audio.play();
		} catch (error) {
			setPreviewError(error instanceof Error ? error.message : "Preview failed.");
		} finally {
			setPreviewing(false);
		}
	};

	return (
		<>
			<SettingsRow
				label="Read tutor messages aloud"
				testid="row-speech-auto"
				hint={
					keyPresent === false ? (
						<>
							Needs an OpenAI key.{" "}
							<button type="button" onClick={onOpenKeys} className="cursor-pointer underline underline-offset-2 hover:text-foreground">
								Add it under Providers
							</button>
						</>
					) : (
						"New tutor messages are rewritten for listening (GPT-6 Luna) and spoken by gpt-4o-mini-tts."
					)
				}
			>
				<Toggle
					checked={current.autoRead && keyPresent !== false}
					disabled={keyPresent === false}
					label="read aloud"
					onChange={(on) => write({ autoRead: on })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Voice"
				testid="row-speech-voice"
				hint={previewError ? <span className="text-red-500/80">{previewError}</span> : "Already spoken messages keep the voice they were recorded with."}
			>
				<span className="flex items-center gap-2">
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="cursor-pointer disabled:cursor-not-allowed"
						disabled={previewing || keyPresent === false}
						aria-busy={previewing}
						onClick={() => void preview()}
						data-testid="speech-preview"
					>
						{previewing && <BrailleSpinner label="Preparing preview" />}
						Listen
					</Button>
					<ThinSelect
						value={current.voice}
						ariaLabel="voice"
						testid="speech-voice"
						onChange={(v) => write({ voice: v as SpeechVoice })}
					>
						{SPEECH_VOICES.map((v) => (
							<option key={v} value={v}>
								{v}
							</option>
						))}
					</ThinSelect>
				</span>
			</SettingsRow>
			<SettingsRow label="Tempo" testid="row-speech-speed" hint="Applies to stored audio too.">
				<span className="flex w-48 items-center gap-2">
					<input
						type="range"
						min={SPEECH_SPEED_MIN}
						max={SPEECH_SPEED_MAX}
						step={0.05}
						value={speed}
						aria-label="tempo"
						data-testid="speech-speed"
						onChange={(e) => setSpeedDraft(Number(e.target.value))}
						onPointerUp={commitSpeed}
						onKeyUp={commitSpeed}
						onBlur={commitSpeed}
						className="h-1.5 w-full accent-primary"
					/>
					<span className="w-10 text-right font-ui text-xs tabular-nums text-muted-foreground">{speed.toFixed(2)}×</span>
				</span>
			</SettingsRow>
			<div className="flex flex-col gap-1.5 py-1" data-testid="row-speech-instructions">
				<span className="flex items-center justify-between gap-4">
					<span className="min-w-0">
						<span className="block font-prose text-(length:--lh-prose-size)">Speaking instruction</span>
						<span className="block text-xs text-muted-foreground/70">How the voice should sound — sent with every new message.</span>
					</span>
					{current.instructions !== DEFAULT_SPEECH_INSTRUCTIONS && (
						<Button
							type="button"
							size="xs"
							variant="ghost"
							className="cursor-pointer"
							onClick={() => {
								setInstructionsDraft(null);
								write({ instructions: DEFAULT_SPEECH_INSTRUCTIONS });
							}}
						>
							Reset
						</Button>
					)}
				</span>
				<textarea
					value={instructions}
					maxLength={SPEECH_INSTRUCTIONS_MAX}
					rows={5}
					aria-label="speaking instruction"
					data-testid="speech-instructions"
					onChange={(e) => setInstructionsDraft(e.target.value)}
					onBlur={() => {
						if (instructionsDraft !== null && instructionsDraft !== current.instructions) write({ instructions: instructionsDraft });
						setInstructionsDraft(null);
					}}
					className="w-full resize-y rounded-sm border border-border bg-background px-2 py-1.5 font-ui text-xs text-foreground outline-none"
				/>
			</div>
		</>
	);
}
