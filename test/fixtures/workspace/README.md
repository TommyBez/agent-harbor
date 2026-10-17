# Agent Harbor live-test workspace

This small invoice module is the only project used by the live CLI scenario. It computes a total from item quantities and unit prices, rounds prices to cents, and applies a percentage discount. Invalid quantities, prices, and discounts are rejected.

Run the two tests with `node --test --test-reporter=tap`.

The live scenario asks an agent to read these files and run the tests without changing them. Session markers are intentionally absent from this workspace; they exist only in the conversation and in a private checkpoint outside the workspace.
