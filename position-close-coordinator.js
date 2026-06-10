export class PositionCloseCoordinator {
  constructor() {
    this.inFlight = new Set();
  }

  get size() {
    return this.inFlight.size;
  }

  has(positionAddress) {
    return this.inFlight.has(positionAddress);
  }

  async run(positionAddress, closeTask) {
    if (this.inFlight.has(positionAddress)) {
      return { acquired: false, result: null };
    }

    this.inFlight.add(positionAddress);
    try {
      return { acquired: true, result: await closeTask() };
    } finally {
      this.inFlight.delete(positionAddress);
    }
  }
}
