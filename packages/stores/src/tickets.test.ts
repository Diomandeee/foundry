import { describe, expect, it } from "vitest";
import { Layer, newScopeToken } from "@foundry/gate-ts";
import { reviveScope, serializeScope } from "./tickets.js";

describe("scope serialization", () => {
  it("round-trips through serializeScope", () => {
    const scope = newScopeToken("proj");
    scope.can_mutate = true;
    const revived = reviveScope(serializeScope(scope));
    expect(revived.scope_id).toBe(scope.scope_id);
    expect(revived.allowed_layers.min).toBeInstanceOf(Layer);
    expect(revived.allowed_layers.max.value).toBe(3);
    expect(revived.allowed_layers.max.toString()).toBe("L3:Apply");
    expect(revived.can_mutate).toBe(true);
  });

  it("revives raw JSON.stringify output (nested {value} layers)", () => {
    const scope = newScopeToken("proj");
    const raw = JSON.stringify(scope); // Layer instances -> {value:n}
    const revived = reviveScope(raw);
    expect(revived.allowed_layers.min).toBeInstanceOf(Layer);
    expect(revived.allowed_layers.min.value).toBe(0);
    expect(revived.allowed_layers.max.value).toBe(3);
  });

  it("rejects garbage layer values", () => {
    const scope = newScopeToken("proj");
    const raw = JSON.stringify({
      ...scope,
      allowed_layers: { min: "L0", max: null },
    });
    expect(() => reviveScope(raw)).toThrow("invalid layer value");
  });
});
