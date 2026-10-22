// What guests (not logged in) may see of the plan.
// Public places keep their name, number and type: corridors, lobbies, toilets, stairs and lifts, and rooms whose
// name says they're open to everyone (library, auditorium, cafeteria...). Classrooms, labs and offices keep only
// their outline and doors, so the map and directions still work, with no number, name or type.
// An editor can override the rule for one room with room.public = true or false.
// web/index.html has a copy of PUBLIC_TYPES, PUBLIC_NAME and isPublic(); keep them the same.

export const PUBLIC_TYPES = new Set(["corridor", "lobby", "toilet", "stairs"]);
export const PUBLIC_NAME = /librar|auditor|cafe|canteen|food court|dining|atrium|lobby|foyer|reception|prayer|surau|musolla|toilet|restroom|washroom|\blift|elevator|stair|exit|entrance|student (service|centre|center|lounge)|multipurpose hall|common room|book ?shop|book ?store|clinic|sick bay|\bgym\b|sports|car ?park|parking|concourse|plaza/i;

export function isPublic(r) {
  if (typeof r?.public === "boolean") return r.public;
  return PUBLIC_TYPES.has(r?.type) || PUBLIC_NAME.test(r?.name || "");
}

/** A guest's copy of a room: public places as they are, other rooms reduced to their outline and doors. */
export function guestRoom(r) {
  if (isPublic(r)) return r;
  return { k: r.k, id: "", name: "", type: "other", floor: r.floor, height: r.height, poly: r.poly, doors: r.doors, private: true };
}

/** A guest's copy of the plan (null stays null). Also drops who saved it last. */
export function guestPlan(p) {
  if (!p) return p;
  const { by, ...rest } = p;
  return { ...rest, rooms: (p.rooms || []).map(guestRoom) };
}
