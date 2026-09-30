import { afterEach, expect, it, vi } from "vitest";
import { NavigationCatalogRegistry } from "../src/navigation-catalog-registry";
import type { RecordingTarget } from "../src/navigation-catalog";

const origin = "https://mylms.korea.ac.kr";
const access = {};
const target = (itemId: string): RecordingTarget => ({
  module: "Week",
  title: "Lecture",
  courseId: "101",
  itemId,
  moduleAccess: access,
  itemAccess: access,
});
const begin = (
  registry: NavigationCatalogRegistry,
  scope: string,
  epoch = 1,
) => {
  const admission = registry.admit(scope);
  const catalog = registry.begin(admission, "account", epoch)!;
  return { admission, catalog };
};

afterEach(() => vi.useRealTimers());

it("isolates published handles by issuer and revokes only a reloaded issuer", () => {
  const registry = new NavigationCatalogRegistry();
  const firstScope = crypto.randomUUID();
  const secondScope = crypto.randomUUID();
  const { admission: admissionA, catalog: a } = begin(registry, firstScope);
  const aHandle = a.replace(origin, [target("501")])[0]!.launchHandle;
  expect(registry.publish(admissionA, a)).toBe(true);
  const { admission: admissionB, catalog: b } = begin(registry, secondScope);
  const bHandle = b.replace(origin, [target("501")])[0]!.launchHandle;
  expect(registry.publish(admissionB, b)).toBe(true);

  expect(aHandle).not.toBe(bHandle);
  expect(registry.findPublished(aHandle)).toBe(a);
  expect(registry.findPublished(bHandle)).toBe(b);

  const { admission: reloadAdmission, catalog: bReload } = begin(
    registry,
    secondScope,
  );
  expect(registry.findPublished(bHandle)).toBeUndefined();
  expect(registry.findPublished(aHandle)).toBe(a);
  registry.discard(reloadAdmission, bReload);
  expect(registry.findPublished(aHandle)).toBe(a);
});

it("prunes expired issuers so the global issuer bound can be reused", () => {
  vi.useFakeTimers();
  const registry = new NavigationCatalogRegistry();
  for (let index = 0; index < 64; index++) {
    const scope = crypto.randomUUID();
    const { admission, catalog } = begin(registry, scope);
    catalog.replace(origin, [target(String(index + 1))]);
    expect(registry.publish(admission, catalog)).toBe(true);
  }
  expect(() => registry.admit(crypto.randomUUID())).toThrow("LIMIT");

  vi.advanceTimersByTime(300_000);
  expect(() => registry.admit(crypto.randomUUID())).not.toThrow();
});

it("counts staging issuers globally and revokeAll closes every epoch catalog", () => {
  const registry = new NavigationCatalogRegistry();
  const catalogs = Array.from({ length: 64 }, () => {
    const scope = crypto.randomUUID();
    return begin(registry, scope);
  });
  expect(() => registry.admit(crypto.randomUUID())).toThrow("LIMIT");

  registry.revokeAll();
  expect(catalogs.every(({ catalog }) => !catalog.hasOwner())).toBe(true);
  expect(() => registry.admit(crypto.randomUUID())).not.toThrow();
});

it("keeps an accepted batch alive across TTL and drops it when released", () => {
  vi.useFakeTimers();
  const registry = new NavigationCatalogRegistry();
  const scope = crypto.randomUUID();
  const { admission, catalog } = begin(registry, scope);
  const handle = catalog.replace(origin, [target("501")])[0]!.launchHandle;
  expect(registry.publish(admission, catalog)).toBe(true);
  const reservation = registry.takeRecordingBatch([handle], origin, Date.now());
  expect(reservation?.catalog).toBe(catalog);

  vi.advanceTimersByTime(300_000);
  expect(registry.isPublished(catalog)).toBe(true);
  reservation?.release();
  expect(registry.isPublished(catalog)).toBe(false);
});

it("keeps an empty catalog published until every overlapping reservation releases", () => {
  vi.useFakeTimers();
  const registry = new NavigationCatalogRegistry();
  const scope = crypto.randomUUID();
  const { admission, catalog } = begin(registry, scope);
  const items = catalog.replace(origin, [target("501"), target("502")]);
  expect(registry.publish(admission, catalog)).toBe(true);
  const first = registry.takeRecordingBatch(
    [items[0]!.launchHandle],
    origin,
    Date.now(),
  );
  const second = registry.takeRecordingBatch(
    [items[1]!.launchHandle],
    origin,
    Date.now(),
  );
  expect(first).toBeDefined();
  expect(second).toBeDefined();

  vi.advanceTimersByTime(300_000);
  first?.release();
  expect(registry.isPublished(catalog)).toBe(true);
  second?.release();
  expect(registry.isPublished(catalog)).toBe(false);
});

it("rejects an older admission without disturbing its replacement", () => {
  const registry = new NavigationCatalogRegistry();
  const scope = crypto.randomUUID();
  const stale = registry.admit(scope);
  const current = registry.admit(scope);
  expect(registry.begin(stale, "account", 1)).toBeUndefined();
  const catalog = registry.begin(current, "account", 1)!;
  const handle = catalog.replace(origin, [target("501")])[0]!.launchHandle;
  expect(registry.publish(current, catalog)).toBe(true);
  registry.discard(stale);
  expect(registry.findPublished(handle)).toBe(catalog);
});

it("fails at the global capability bound without revoking another issuer", () => {
  const registry = new NavigationCatalogRegistry();
  const targets = Array.from({ length: 10_000 }, (_, index) =>
    target(String(index + 1)),
  );
  const scopeA = crypto.randomUUID();
  const { admission: admissionA, catalog: a } = begin(registry, scopeA);
  const aItems = a.replace(origin, targets);
  expect(registry.publish(admissionA, a)).toBe(true);
  const scopeB = crypto.randomUUID();
  const { admission: admissionB, catalog: b } = begin(registry, scopeB);
  b.replace(origin, targets);
  expect(registry.publish(admissionB, b)).toBe(true);

  const overflowScope = crypto.randomUUID();
  const { admission: overflowAdmission, catalog: overflow } = begin(
    registry,
    overflowScope,
  );
  expect(() => overflow.replace(origin, [target("1")])).toThrow("LIMIT");
  registry.discard(overflowAdmission, overflow);
  expect(registry.findPublished(aItems[0]!.launchHandle)).toBe(a);
});
