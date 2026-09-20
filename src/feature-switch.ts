/**
 * pi-cache — a named boolean switch.
 *
 * One responsibility: own a single toggleable boolean and nothing else, so
 * a holder with several switches shares one mutation implementation instead
 * of parallel field/accessor plumbing.
 */

export class FeatureSwitch {
  constructor(private value: boolean) {}

  get enabled(): boolean {
    return this.value;
  }

  set(enabled: boolean): void {
    this.value = enabled;
  }
}