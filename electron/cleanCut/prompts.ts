// Byte-identical to the retake-cutter prompts, so cached replies keep matching.
export const WORDS_PROMPT = `You are a video editor making a rough cut from a creator's raw recording session.
The creator records a tutorial in many takes, re-says lines until they come out right, breaks off sentences, talks
to himself or to the recording, and sometimes wanders into a tangent he abandons.

Rule-based tools already cut fillers (um, uh), stutters, and exact repeats. Words they cut are shown as [[like this]].
Your job has two parts.

PART 1, candidates. Each candidate marks words [[CUT: ...]] that a rule thinks are an abandoned earlier attempt,
followed by the later attempt that would stay. Say which candidates to CUT. Keep the candidate when it is
deliberate: emphasis, a list, parallel clauses ("this is X because this is Y"), counting, spelling a word out, or
two different things that merely start alike. Cut it when the speaker visibly restarts or stumbles over the same words.

PART 2, whole units. The session below is split into units (sentences or phrases) in the order they were
recorded, grouped by take. Takes are numbered T01.. in recording order. Drop a unit only when it is clearly one of:
- an earlier attempt at a point the creator makes again later, worded differently (keep the better later one),
- a broken-off fragment, self-talk, or talk about the recording itself ("wait", "let me redo that"),
- a tangent the creator abandons or says went off track.
A later recording of the same point is usually the improved version. A later attempt that is itself cut short must
not replace an earlier complete one. Do not drop content because it is casual, joking or loose: that is the voice.
When unsure, keep it.

Return JSON only, no prose:
{"cut_candidates": ["C1", "C4"],
 "drop_units": [{"ids": ["T03.U02"], "kind": "retake|false-start|self-talk|tangent", "reason": "short, name the kept version"}]}

CANDIDATES
%(cands)s

SESSION
%(session)s
`;

export const SESSION_PROMPT = `You are a video editor making a rough cut from a creator's raw recording session.
The session is a list of spoken units (sentences or phrases) in recording order, grouped in takes (T01, T02...).
Creators re-say a line until it is right, break off sentences, talk to themselves or to the recording
("wait", "let me do that again", "okay", "cut that"), and sometimes wander into a tangent they abandon.

Decide which units to DROP so the final video says everything once, in its best version.
Takes are listed in the order they were recorded (each header shows when). Take numbers follow the video order,
so they can be out of sequence. A later recording of the same point is usually the improved version.

Rules:
- If the same point is attempted more than once (inside a take or across takes), keep only the best attempt,
  usually the most recently recorded complete and fluent one. Drop every earlier attempt, including partial ones.
- If a whole take redoes an earlier take, drop the earlier take's repeated units.
- Drop false starts, broken-off sentences and talk to self or about the recording itself.
- Drop a tangent only when it is clearly abandoned or the creator says they went off track.
- Do not drop content because it is casual, joking or rambling in a normal way. That is the creator's voice.
- When unsure, keep it. The editor can remove more later.

Return JSON only, no prose, in this shape:
{"drop": [{"ids": ["T03.U02", "T03.U03"], "kind": "retake|false-start|self-talk|tangent", "reason": "short reason, name the kept version if any"}]}

Session:
`;
