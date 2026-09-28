# Family Learning Games --- Requirements v0.7.1

## 1. Objective

v0.7.1 improves the quality, reproducibility, and operational behavior
of AI-generated games while preserving the v0.7 architecture and public
API.

## 2. Functional requirements

### FR-0711-01 --- Claude Sonnet generation

When AI generation is enabled, the configured generator for v0.7.1 shall
use Claude Sonnet 4.6 through Amazon Bedrock. The model ID shall remain
external configuration.

### FR-0711-02 --- Claude Sonnet validation

The independent AI validator shall use Claude Sonnet 4.6 through Amazon
Bedrock. Generator and Validator shall remain independent invocations
even when configured with the same foundation model.

### FR-0711-03 --- Deterministic validation

Application shall continue to deterministically evaluate the Validator
result before accepting generated questions. AI output shall not become
trusted merely because Generator and Validator agree.

### FR-0711-04 --- Age-aware generation

When a generation request contains `playerId`, Application shall resolve
the player and derive `targetAge`. Only `targetAge`, not player
identity, shall cross the AI boundary.

### FR-0711-05 --- Difficulty independence

`difficulty` shall remain independent from `targetAge`. Increasing
difficulty shall increase the challenge within the knowledge and
language boundaries appropriate for the target age.

### FR-0711-06 --- Easy questions

Easy questions shall favor basic knowledge, direct recall, and
relatively simple distractors appropriate for the target age.

### FR-0711-07 --- Normal questions

Normal questions shall require more specific topic knowledge and use
plausible distractors that cannot normally be eliminated solely because
they are unrelated to the question.

### FR-0711-08 --- Hard questions

Hard questions shall require detailed or less obvious knowledge of the
topic while remaining appropriate for the target age. Hard games shall
avoid filling their question set with basic introductory questions that
would also naturally qualify as easy.

### FR-0711-09 --- Intra-game diversity

A generated game shall not contain exact duplicate questions. The
generation instructions shall discourage semantically equivalent
questions within the same generated game. Persistent cross-game semantic
duplicate detection is not required.

### FR-0711-10 --- Distractor quality

Each generated question shall contain exactly one correct answer. For
normal and hard difficulties, incorrect alternatives should be plausible
within the question's conceptual context.

### FR-0711-11 --- Answer-position integrity

The correct answer position presented to the player shall not be
predictable from generator output ordering.

The implementation shall first verify the existing end-to-end answer
ordering behavior. If no shuffle currently exists, answer choices shall
be randomized while preserving the correct-answer association.

### FR-0711-12 --- Guardrails

Existing Bedrock Guardrail enforcement shall remain enabled for AI
generation and validation.

The existing guarded-topic mechanism shall not be changed solely because
of the migration from Nova to Claude; testing has demonstrated that
Claude Sonnet 4.6 can consume the guarded topic.

### FR-0711-13 --- Repair

Existing accepted-question retention and missing-question repair
behavior shall be preserved. The system shall not unnecessarily
regenerate already accepted questions.

### FR-0711-14 --- Execution budget

The system shall avoid beginning an additional repair/retry operation
when the remaining Lambda execution budget is insufficient to complete
it safely.

Insufficient remaining execution time shall result in a controlled
application failure rather than an uncontrolled Lambda timeout.

### FR-0711-15 --- Diagnostic context

AI generation telemetry shall provide sufficient non-sensitive context
to correlate and diagnose failed generation attempts.

At minimum, diagnostic design shall cover correlation identifier,
attempt/round, difficulty, targetAge, an appropriately implemented topic
fingerprint/hash, requested/accepted counts, generator/validator model
identifiers, and generator/validator durations.

### FR-0711-16 --- Validator rejection diagnostics

Blocking Validator rejections should expose a bounded diagnostic
`reason` to server-side logs.

The diagnostic reason shall not be returned as internal AI metadata to
the public client unless already part of an explicitly accepted API
contract.

## 3. Non-functional requirements

### NFR-0711-01 --- Provider independence

Domain and Application shall remain independent from Bedrock and
Anthropic SDK/model-specific types.

### NFR-0711-02 --- Reproducible deployment

The v0.7.1 AI model configuration shall be represented in repository/CDK
configuration. A future deployment shall not silently revert the
manually tested Claude configuration to Nova.

### NFR-0711-03 --- No additional infrastructure

v0.7.1 shall not require new AWS resources.

### NFR-0711-04 --- Data minimization

AI telemetry and prompts shall not contain player identity or
unnecessary family metadata.

### NFR-0711-05 --- Cost awareness

Repair/retry behavior shall avoid unnecessary Claude invocations.

### NFR-0711-06 --- Backward compatibility

Existing HTTP routes and persisted Game, GameSession, and Player
behavior shall remain compatible.

### NFR-0711-07 --- PWA compatibility

The v0.7 online-first PWA behavior defined by ADR-014 shall remain
unchanged.

## 4. Validation requirements

Automated tests shall cover, where applicable:

-   Claude model configuration;
-   generator/validator configuration remains external;
-   difficulty prompt semantics;
-   age/difficulty independence;
-   intra-game duplicate rules already enforced by Application;
-   correct-answer ordering behavior;
-   answer shuffling if required;
-   preservation of correct-answer mapping after shuffle;
-   Validator blocking issues;
-   diagnostic reason bounding/sanitization;
-   telemetry without player identity;
-   execution-budget behavior before additional repair/retry;
-   existing API compatibility;
-   existing PWA behavior.

Normal automated tests must not require live AWS or Bedrock.

## 5. Manual validation

Perform controlled generation tests using representative topics such as:

-   Mundiales de Fútbol;
-   Pokémon;
-   a specific entertainment topic such as K-pop.

For at least one topic, compare `easy`, `normal`, and `hard` using the
same target age.

Review factual correctness, topic relevance, question diversity,
distractor plausibility, observable difficulty separation, and
answer-position distribution.

Manual testing is quality evidence, not a replacement for deterministic
validation.

## 6. Definition of Done

v0.7.1 is complete when:

-   Claude Sonnet 4.6 is the reproducibly configured Generator model;
-   Claude Sonnet 4.6 is the reproducibly configured Validator model;
-   no manual Lambda model override is required after deployment;
-   Generator and Validator remain independent invocations;
-   deterministic validation remains in place;
-   difficulty instructions clearly distinguish easy, normal, and hard;
-   targetAge and difficulty remain independent;
-   intra-game diversity requirements are explicit;
-   normal/hard distractors are materially more plausible;
-   correct-answer ordering cannot trivially reveal the answer;
-   failed generations have sufficient non-sensitive diagnostic context;
-   repair behavior respects the available execution budget;
-   Guardrails remain enabled;
-   no player identity crosses the AI boundary;
-   no new AWS resources are introduced;
-   v0.7 PWA behavior remains unchanged;
-   existing API contracts remain compatible;
-   standard project validations pass.
