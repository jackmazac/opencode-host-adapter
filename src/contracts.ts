// Re-export the canonical fleet contracts so plugin authors have a single
// dependency (`@mazac-fox/opencode-host-adapter`) for both plugin wrapping
// and fleet contract types. Direct import from
// `@mazac-fox/opencode-fleet-contracts` also works for CLIs / daemons /
// tooling that do not need the plugin wrapper.
export * from "@mazac-fox/opencode-fleet-contracts";
