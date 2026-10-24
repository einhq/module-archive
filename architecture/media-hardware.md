# Media work on any hardware, and how it heals

How the media side copes with the machine it runs on, a 16 GB card, a smaller one or none, and
with trouble along the way: a busy or restarting EMS, a file nothing can decode, a crash. Its goal
is that nothing fails for a reason that passes, and that what a person sees says whether the
system is keeping up. The details live where each part is built; this page is the whole picture,
with links.

Three processes take part:

- **EiN** runs the pipelines. A step is a shell command, most of them a call into EMS.
- **EMS** (ein/ems) holds every model and media tool, and decides where each model runs.
- **The llm** (ein/llm) is the assistant's language model, a llama.cpp server. On fry it shares
  the card with EMS.

## Where models run

EMS places each model family when it loads it: on the card if there is room, otherwise on the
CPU with the same weights. Placement changes only how fast a family runs, never what it answers.
The card is not judged by how much happens to be free between two requests. Each family resident
there claims its whole need, its weights plus what it works with mid-request, and a new family
goes on the card only if its need is free now **and** still left once every claim is counted.
Measuring free memory alone had two families, each placed within it, run the card out of memory
together mid-request.

| Family                                              | Claims on the card | Without room                |
| --------------------------------------------------- | ------------------ | --------------------------- |
| whisper large-v3                                    | 4.0 GB (float16)   | waits on a host with a card |
| faces, picture vectors, text vectors                | 2.5–2.6 GB each    | runs on the CPU             |
| voices: sortformer, titanet, active-speaker scoring | 1.5, 0.5, 0.3 GB   | runs on the CPU             |

One family follows a rule of its own:

- **whisper runs in one place per host.** On a host with a card, that is always the card, in
  float16, and a transcription waits for room rather than move to the CPU. On a host without a
  card, it is the CPU, in int8. The place is part of the transcript's signature
  (`on=cuda:float16`). One precision on both devices was measured and does not give the same
  words: int8 on the card and int8 on the CPU differed in 7% of words on Swedish home video. So
  the rule is that a transcript never depends on what else was on the card at the time.

**A card shared with the llm** is split by one number, set on both sides in the host profile:
`EMS_CARD_SHARE_MB` (the most EMS's own processes hold) and `LLM_CARD_RESERVE_MB` (what the llm
leaves EMS). Neither then loads into the other's part, whichever starts first. EMS measures its
own use with `nvidia-smi`, which in its container lists only its own processes. The llm gets as
many layers as fit what is left (`-ngl auto --fit`) and restarts until it loads; layers that do
not fit run on the CPU, and it answers slower. The llm's reserve is 0.4 GB larger than EMS's share:
it counts the card as `nvidia-smi` does, and torch never sees that much of it.

An llm that is not ours (`CFG_LLM_URL` at a provider
elsewhere, named in `CFG_LLM_PROVIDER`) has no part of the card, and EMS takes all of it. The host
profile tells EiN which it is and, of ours, where it runs (`CFG_LLM_CARD`: `card` or `cpu`); `llm-status` and the chat say so from there.

What a host gets: every output, on any card or none; a smaller card only makes the work slower.

| Card            | Transcripts                       | Everything else                         | llm                |
| --------------- | --------------------------------- | --------------------------------------- | ------------------ |
| 16 GB, with llm | the card, float16                 | the card                                | on the card        |
| 12 GB           | the card, float16                 | the card when there is room, or the CPU | partly on the card |
| 8 GB            | the card, float16                 | the card when there is room, or the CPU | on the CPU         |
| none            | the CPU, int8, about 2x the audio | the CPU                                 | on the CPU         |

Rehearsed on fry (wow `notes/host-and-runtime-limits.md`, "Smaller cards and no card";
`EMS_CARD_BUDGET_MB` and `LLM_CARD_MB` make the big card behave as a smaller one): no card size ran
out of memory or failed a step, and on an 8 GB card EMS peaked at 5.0 GB.

With `EMS_EXPECT_GPU=1`, a host that should have a card and sees none
runs as a host without one, and says so. EMS's side is in its `docs/api.md` (2.6 The card).

## When a step cannot run

A step's exit code says whose failure it was (`src/lib/step-exit.ts`;
core's `docs/architecture/data-flow.md` has the details). The bins that call EMS map its answer with
`stepExitCode`.

| Exit          | Meaning                                                       | What happens                                                                                                                                   |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 75            | EMS cannot do it now: busy, loading, restarting, unreachable  | Nothing fails, and no attempt is spent. A pooled kind rests 30 s, doubling to 10 min; a step the engine runs itself waits 5 min (`notBefore`). |
| 65            | the input cannot be processed: undecodable bytes, a text file | The step fails at once with `cause: input`, and is never run again.                                                                            |
| anything else | the step's own failure                                        | An attempt is spent; once all are spent, the instance fails.                                                                                   |

A planned EiN restart hands every claimed job back with its attempt returned. Only a crash spends
one, so a step that kills its worker every time does run out.

## Healing

- **`pipeline heal`**, run hourly by the `pipeline-pruner` service, reruns failed instances 1 h,
  6 h and 24 h after they failed. After the third it marks them `needsPerson` and leaves them for
  a person. Instances that failed on their input are left alone. Failed instances are kept until
  they are healed or marked.
- **A new EMS build** reruns every failed instance at once (`pipeline heal --now`, from the
  `ems-link` service): a new build is the likeliest fix. Such a run is out of turn and does not
  count as a heal.
- **`media-heal`** (an archive service) closes gaps nothing announced: a file that never got its
  fingerprint, transcript, voices, picture vectors or extracted text, or whose transcript or vectors are from a
  superseded model or setting. It runs `media-scan` only when the media and trigger pools have nothing ready.
  A gap seen then is a real gap, not work on its way, and is announced once. It resumes where its
  last slice stopped, and rests six hours after a complete pass (`CFG_MEDIA_HEAL_INTERVAL`,
  `CFG_MEDIA_HEAL_REST`). This is also how a change of model or setting reaches the whole archive:
  a new transcript signature transcribes every recording again, as the engine has time
  (`CFG_MEDIA_TRANSCRIPTS_CURRENT=off` keeps the transcripts there are).

## Seeing it

`health` answers one question, whether the system is well and keeping up, with a verdict and the
checks behind it:

- `healthy` means nothing is waiting.
- `catching-up` means work is waiting, and some of it finished in the last hour.
- `stuck` means work is waiting, and none of it finished in the last hour.
- `needs-person` means a check failed.

Core checks every pool kind with work waiting: draining, resting for EMS, or with no worker at all.
It also checks failed work (being healed: a warning; marked for a person: a failure), input
nothing can process, quiet steps and dropped queue entries.

A module adds its own checks through a service's `checkCommand`, and meters through its
`gaugeCommand` (core's `docs/architecture/modules.md`). ems reports whether EMS answers, its model worker, each
degradation and the card mode, plus GPU and VRAM gauges. A card the host should have and does not
see is the one EMS check that fails. The assistant reports whether its language model answers,
whose it is, and of ours whether it has every layer on the card, part of them, or runs on the CPU.

The system page carries the verdict as a badge in its header, on every tab, and its Overview
lists the checks that are not fine, when there are any; `top`'s Work panel leads with both. `top`
draws the gauges beside RAM. The Work tab lists every kind of work: what is left, its rates and
ETA, how long the oldest job has waited, and why a kind is not moving.
`pool-stat` prints the same figures in a shell.
