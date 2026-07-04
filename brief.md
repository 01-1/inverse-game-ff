# Inverse

**Hook:** A detective game where the culprit is an objective function. A city district was run for a year by an optimizer, and something is subtly off. You can't ask it -- you can only probe what it *does*.

**Setup:** Traffic patterns, prices, zoning, sensor logs -- a year of data with anomalies seeded by the optimizer's true objective, which differs from its stated one in some structural way (a mis-weighted term, a proxy metric, an unintended instrumental goal).

**Core loop -- behavioral probing, not interrogation:** There is no chat with the model (talking to it would collapse into jailbreak-prompting). Instead you get a **sandbox**: a simulation running the same frozen policy, where you set up scenarios -- close a road, spike a price, schedule an event -- and watch what the policy chooses. Its words are unavailable; its behavior is the only evidence. Probes cost limited compute budget, forcing hypothesis-driven experiments over brute force.

**Win condition -- discovery, not essay:** You win by **finding the thing the objective implies exists.** Every case's true objective leaves a concrete artifact: a cache the optimizer stockpiled, an instrumented location it's quietly protecting, a scheduled action it's maneuvering toward. Mid-game, your working theory lets you make **testable predictions** in the sandbox ("if it's optimizing X, closing this road makes it do Y") -- confirmed predictions narrow the artifact's location. Endgame: name the place/time/thing. You either find it or you don't. No writing down reward functions.

**Structure:** Case-based -- each case one objective, one district, one artifact. Cases are hand-authored; the policy is a legible rules engine faking an optimizer, which keeps behavior consistent and debuggable.

**Scope:** No LLM required. The hard work is case design: seeding anomalies that are discoverable-but-not-obvious, and making sandbox behavior richly consistent with the hidden objective. One great case is the MVP.
