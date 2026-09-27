import {
  NavigationCatalog,
  type NavigationCatalogCapacity,
} from "./navigation-catalog";

interface IssuerCatalogs {
  generation: number;
  staging?: NavigationCatalog;
  published?: NavigationCatalog;
}

export interface NavigationCatalogAdmission {
  readonly scope: string;
  readonly generation: number;
}

const MAX_CAPABILITIES = 40_000;
const MAX_ISSUERS = 64;

/** Bounded, content-document-memory-only owner of per-list capability catalogs. */
export class NavigationCatalogRegistry {
  private readonly issuers = new Map<string, IssuerCatalogs>();
  private readonly reservations = new Map<NavigationCatalog, number>();
  private capabilityCount = 0;
  private generation = 0;
  private readonly capacity: NavigationCatalogCapacity = {
    reserve: (count) => {
      if (this.capabilityCount + count > MAX_CAPABILITIES) return false;
      this.capabilityCount += count;
      return true;
    },
    release: (count) => {
      this.capabilityCount = Math.max(0, this.capabilityCount - count);
    },
  };

  admit(scope: string): NavigationCatalogAdmission {
    this.revoke(scope);
    if (this.issuers.size >= MAX_ISSUERS) throw new Error("LIMIT");
    const admission = { scope, generation: ++this.generation };
    this.issuers.set(scope, { generation: admission.generation });
    return admission;
  }

  begin(
    admission: NavigationCatalogAdmission,
    account: string,
    epoch: number,
  ): NavigationCatalog | undefined {
    const { scope, generation } = admission;
    const admitted = this.issuers.get(scope);
    if (admitted?.generation !== generation) return undefined;
    const catalog = new NavigationCatalog(account, epoch, this.capacity, () => {
      const current = this.issuers.get(scope);
      if (
        current?.published === catalog &&
        catalog.size() === 0 &&
        !this.reservations.has(catalog)
      )
        this.issuers.delete(scope);
    });
    admitted.staging = catalog;
    return catalog;
  }

  publish(
    admission: NavigationCatalogAdmission,
    catalog: NavigationCatalog,
  ): boolean {
    const current = this.issuers.get(admission.scope);
    if (
      current?.generation !== admission.generation ||
      current.staging !== catalog
    )
      return false;
    current.staging = undefined;
    current.published = catalog;
    return true;
  }

  discard(
    admission: NavigationCatalogAdmission,
    catalog?: NavigationCatalog,
  ): void {
    const current = this.issuers.get(admission.scope);
    if (current?.generation !== admission.generation) return;
    if (catalog && current.staging !== catalog) return;
    catalog?.revoke();
    current.staging = undefined;
    if (!current.published) this.issuers.delete(admission.scope);
  }

  revoke(scope: string): void {
    const current = this.issuers.get(scope);
    if (!current) return;
    current.staging?.revoke();
    current.published?.revoke();
    this.issuers.delete(scope);
  }

  revokeAll(): void {
    for (const current of this.issuers.values()) {
      current.staging?.revoke();
      current.published?.revoke();
    }
    this.issuers.clear();
  }

  findPublished(handle: string): NavigationCatalog | undefined {
    for (const current of this.issuers.values())
      if (current.published?.has(handle)) return current.published;
    return undefined;
  }

  takeRecordingBatch(
    handles: readonly string[],
    origin: string,
    now: number,
  ):
    | { catalog: NavigationCatalog; urls: string[]; release: () => void }
    | undefined {
    const catalog = this.findPublished(handles[0] ?? "");
    if (!catalog) return undefined;
    const urls = catalog.takeRecordingBatch(handles, origin, now);
    if (!urls) return undefined;
    this.reservations.set(catalog, (this.reservations.get(catalog) ?? 0) + 1);
    let released = false;
    return {
      catalog,
      urls,
      release: () => {
        if (released) return;
        released = true;
        const count = this.reservations.get(catalog) ?? 0;
        const remaining = Math.max(0, count - 1);
        if (remaining) this.reservations.set(catalog, remaining);
        else this.reservations.delete(catalog);
        for (const [scope, current] of this.issuers) {
          if (current.published !== catalog) continue;
          if (catalog.size() === 0 && remaining === 0)
            this.issuers.delete(scope);
          break;
        }
      },
    };
  }

  isPublished(catalog: NavigationCatalog): boolean {
    for (const current of this.issuers.values())
      if (current.published === catalog) return true;
    return false;
  }
}
