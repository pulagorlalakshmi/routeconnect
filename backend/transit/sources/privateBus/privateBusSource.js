// Private intercity bus: an ADAPTER SLOT, deliberately empty.
//
// Feasibility (2026-10-08): private operators' schedules in India are sold through booking platforms (redBus,
// AbhiBus, MakeMyTrip/Goibibo, Paytm, ...) and operator back-office systems. None of them offers an open, public
// timetable API; access is by commercial partner/B2B agreement. Scraping their websites is not permitted and is not
// done here. So no private bus is ever shown until a partner integration exists.
//
// To add one later, implement `search(ctx)` against the partner API and return journeys or trunk legs whose operator
// name comes from that API (operatorIdentity(name, { source: 'partner:<id>', typeHint: 'private_bus' })).
// Never derive a private operator from a service number, a stop or a price.

export function createPrivateBusSource({ partner = null } = {}) {
  return {
    id: 'private_bus',
    label: 'Private intercity buses',
    mode: 'bus',
    timeoutMs: 6000,
    status() {
      if (!partner) return { configured: false, reason: 'No licensed private-bus data source is available. Booking sites are not scraped.' };
      return { configured: true };
    },
    async search(ctx) {
      return partner.search(ctx);
    }
  };
}
