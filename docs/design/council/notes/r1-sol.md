## 1. Production Optimizer

*Turn a production goal into a factory specification, with clear trade-offs and a diagnosis when the goal is out of reach.*

**Who it's for and how they work.** Players deciding what to build or upgrade, from a first motor line to an endgame complex. They enter targets and available inputs, compare plans that favor power, scarce resources, or building count, and see which unlock or capacity increase would make the biggest difference.

**What "everything" means.** Cover the decisions that determine a production plan: progression and unlocks, recipe alternatives, node and transport limits, power, byproducts, boost allocation, and staged targets. The deliverable is a build specification with machine counts, settings, and rates. Players choose sites and route individual belts and pipes in-game.

**Why it's a good bet and where it could fail.** This builds on v1's strongest capability and offers the quickest route from a question to an answer. The biggest risk is precision that users mistake for buildability. A solution can satisfy the modeled constraints while still leaving substantial construction work.

**What v1 contributes.** Keep save-aware constraints, reachability explanations, and prioritized objectives. Validate suggested fixes against whole-building rules and report power at the actual clocks in the plan.

## 2. World Development Planner

*Use the map of your save to decide where the next factory goes and how it fits into the world you've already built.*

**Who it's for and how they work.** Players managing a long-running save with multiple sites. They open the latest save, inspect claimed and available resources, reserve nodes for projects, compare sites, and plan which factories will supply each other as the world grows.

**What "everything" means.** Cover world-scale planning: resource claims, site capacity, power and transport corridors, imports and exports between factories, and construction phases. Each site has a production budget and a clear account of what it owes other sites. Detailed machine placement and belt routing remain in-game work.

**Why it's a good bet and where it could fail.** The app earns a place alongside the game because each import helps answer what to do next. The biggest risk is inferring factory boundaries, capacities, or connections incorrectly. Players need to be able to correct those interpretations and carry their decisions forward when a new save arrives.

**What v1 contributes.** Use the verified node IDs and coordinates, the default catalog plus save overrides, and the well links. Extend v1's distinction between a persistent save session and individual snapshots so a player can track changes while keeping their planned projects.

## 3. Factory Design Workbench

*Design a factory module you can build from, with production rates, routing, and construction steps in one workspace.*

**Who it's for and how they work.** Builders who iterate on a design before committing foundations. They start from a blank project or a solver proposal, arrange machines into modules, connect inputs and outputs, and revise the plan where space, power, or throughput becomes tight. They return to the same project while building the factory in-game.

**What "everything" means.** Cover the path from target rate to construction: recipe and machine selection, clock and boost settings, module footprints, explicit belt and pipe connections, power budgets, materials lists, and build order. The planning unit is a factory or reusable module. Players manage world expansion and carry out construction in-game.

**Why it's a good bet and where it could fail.** It closes the gap between knowing the required machine counts and knowing how to put them together. The biggest risk is spending the rewrite recreating the game's building editor. A first release can prove the workflow with dimensioned modules and explicit connections, with full 3D placement outside that release's scope.

**What v1 contributes.** Keep the expandable flow graph and verified machine, clock, and port limits. Treat v1's proportionally assigned graph edges as a proposed flow. Validate the connections the player actually specifies as part of the build plan.

## Recommendation

Choose **Factory Design Workbench**, with the save-aware optimizer generating starting designs and checking edits. V1 already answers how many machines a target needs. The rewrite can turn that answer into something players can build from. I'd judge the first release by whether a player can take one factory from target rate through construction without rebuilding the plan in a spreadsheet or sketch.

Two questions for the owner:
- Which should anchor the first release: expanding an established save or designing a self-contained factory from scratch?
- How much construction detail would make a plan usable in-game: dimensioned modules and explicit connections, or placement accurate to individual foundations?
