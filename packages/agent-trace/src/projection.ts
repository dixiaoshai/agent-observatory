/**
 * Version of the normalized event projection produced by the runtime adapters.
 *
 * Bump this whenever an adapter changes the meaning or shape of an archived
 * event payload, even if the source records themselves are unchanged. An archive
 * records the version that produced its events; writers refuse to mix versions,
 * because stale payloads cannot be reconciled in place: event identity is stable
 * across normalizer versions and strict consumers reject re-emitted identities.
 * Upgrades therefore require rebuilding into a new archive database and
 * recreating the consumer databases.
 */
export const PROJECTION_VERSION = 'normalizer-v2';
