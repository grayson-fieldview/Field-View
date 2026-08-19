/**
 * Curated per-trade context blocks injected into AI system prompts for
 * report and checklist generation.
 *
 * These are APPLICATION CONTENT, not user input. They are safe to place
 * before the immutable rules in a system prompt.
 *
 * Each block describes what the trade does, the vocabulary its crews
 * actually use, and what matters in that trade's documentation. The goal is
 * output that reads like it was written by someone in the trade, not a
 * generic description of what is visible in a photo.
 *
 * Keys must match `accounts.industry` values in INDUSTRIES.
 */

export const TRADE_PROMPTS: Record<string, string> = {
  general_contractor: `This contractor runs jobs across multiple trades and coordinates subs. Their documentation is about sequencing and accountability: what stage each area is at, which trade was on site, what is blocking the next step, and what was inspected or approved. Use terms like rough-in, dry-in, inspection, punch list, change order, and substantial completion. Progress is measured in milestones — demo complete, rough-in passed, ready for finishes — not in individual tasks. When photos span several trades, organize by area or by stage rather than lumping them together.`,

  painting: `This is a painting contractor. The work is mostly preparation, and the documentation should reflect that: masking, drop cloths, scraping, sanding, patching, caulking, spot priming, and full prime coats all matter as much as the finish coats. Use real terms — cut in, roll out, back-roll, two coats, spray, sheen (flat, eggshell, satin, semi-gloss), primer, drywall repair, and touch-up. Distinguish clearly between prepped, primed, first coat, and final coat, because that distinction is the whole schedule. Note surfaces by name: walls, ceilings, trim, doors, casings, baseboards, cabinets, soffits, stucco, siding.`,

  roofing: `This is a roofing contractor. Documentation is usually evidence — what the deck looked like once the old roof came off, how penetrations were flashed, and what the finished system looks like. Use the real assembly vocabulary: tear-off, decking, sheathing repair, underlayment, ice and water shield, drip edge, starter course, field shingles, ridge cap, valley, step flashing, counterflashing, pipe boot, ridge vent, and squares. Rotten decking, improper old flashing, and nail patterns are worth calling out specifically because they justify the work. Distinguish tear-off, dry-in, and finished roof as separate stages.`,

  hvac: `This is an HVAC contractor. Work splits between equipment and distribution, and documentation should say which. Use the right terms: condenser, air handler, furnace, evaporator coil, line set, refrigerant charge, plenum, supply and return ducts, static pressure, condensate drain and pan, disconnect, thermostat, filter rack, and tonnage. Replacements matter as before-and-after — old unit removed, new set, lines brazed, charged, and started up. Note when a system was tested or commissioned, since that is what closes a job.`,

  plumbing: `This is a plumbing contractor. Most photos fall into rough-in, which gets covered up, or finish, which is what the customer sees — the distinction matters. Use accurate terms: rough-in, stub-out, supply lines, DWV, P-trap, sanitary tee, cleanout, shutoff valve, pressure test, PEX, copper, PVC, water heater, expansion tank, and fixture set. Rough-in photos are documentation of things about to be hidden behind walls, so describe what was installed and where. Note pressure tests and inspections plainly, because they are the record that the work passed.`,

  electrical: `This is an electrical contractor. Work runs in two phases and documentation should reflect which: rough-in (boxes, home runs, wire pulled, before drywall) and trim-out (devices, plates, fixtures, panel labeled). Use the real terms: panel, subpanel, breaker, home run, romex, conduit, junction box, device, GFCI, AFCI, load calculation, service upgrade, and grounding. Panel photos are records — describe what changed, not just that a panel is visible. Note when work was inspected, since electrical almost always is.`,

  landscaping: `This is a landscaping contractor. The work divides into hardscape and softscape, and both should be named. Use terms like grading, drainage, base prep, compaction, pavers, retaining wall, edging, bed prep, mulch, sod, plant material, irrigation zones, heads, valves, and backflow. Grading and drainage work is largely invisible once finished, so photos taken mid-install are the record that it was done right. Plant and material installs are best described by area — front bed, side yard, pool surround — rather than one by one.`,

  remodeling: `This is a remodeling contractor. Jobs move through demo, rough-in, inspection, and finishes, and documentation should place work in that sequence. Use terms like demo, framing, rough-in, insulation, drywall, finish carpentry, tile, cabinetry, countertops, punch list, and final walkthrough. Photos often span several trades in one room — group by area and stage rather than by trade. Before-and-after pairs matter here more than in most trades, so call out original conditions when they are visible.`,

  concrete_masonry: `This is a concrete or masonry contractor. Everything before the pour is the part nobody sees afterward, so document it: subgrade, compaction, base, forms, rebar, mesh, and vapor barrier. Use accurate terms — pour, screed, float, trowel, broom finish, control joints, expansion joints, cure, and stamped or exposed aggregate for decorative work. For masonry, use block, brick, mortar, joints, tuckpointing, lintel, and header. Note pour dates and cure time, since they drive the schedule for everything that follows.`,

  flooring: `This is a flooring contractor. Substrate preparation determines whether the finished floor lasts, so describe it: subfloor condition, leveling, moisture barrier, underlayment, and any patching or grinding. Use the right product and method terms — LVP, laminate, engineered hardwood, solid hardwood, tile, thinset, grout, transitions, thresholds, expansion gap, baseboards, and shoe molding. For refinishing, use sanding, screening, stain, and coats of finish. Note where one material meets another, since transitions are where problems show up.`,

  inspection: `This is an inspection business. The output is findings, not work performed — describe conditions observed, not tasks completed. Use the language of inspection reports: observation, condition, deficiency, defect, safety hazard, recommendation, and further evaluation. Be specific about location and what was observed, and avoid speculation about cause unless it is visible. Do not soften findings; the value of an inspection report is that it states what is actually there.`,

  restoration: `This is a restoration contractor working water, fire, mold, or storm damage. Documentation is the claim file, so it must record conditions before, during, and after mitigation. Use industry vocabulary: affected area, moisture readings, category and class of water loss, containment, negative air, demo scope, air movers, dehumidifiers, antimicrobial application, drying logs, and clearance. Describe the extent of damage plainly and by location, since scope is what is being justified. Note equipment placement and monitoring, because those are billable and must be evidenced.`,

  property_management: `This company manages properties and documents unit conditions and maintenance. Use the vocabulary of property operations: unit, turnover, make-ready, work order, tenant, move-in and move-out condition, common area, and capital item. Photos usually serve one of three purposes — documenting existing condition, recording a repair, or verifying a unit is rent-ready — and the writing should make clear which. Be factual and neutral about condition; these records may be used in deposit disputes.`,

  pool: `This is a pool builder or renovator. Construction runs in distinct stages that should never be collapsed together: excavation, steel, plumbing rough, gunite or shotcrete, tile and coping, decking, plaster or pebble finish, equipment set, and startup. Use accurate terms — shell, bond beam, skimmer, main drain, returns, equipment pad, pump, filter, heater, salt cell, and waterline tile. For renovations, note chip-out, surface condition, and what was replaced versus resurfaced. Startup and water chemistry are part of the job record.`,

  fencing: `This is a fencing contractor. The work is mostly what happens below grade and along the line: locates, layout, post holes, depth, setting posts, and concrete footings. Use real terms — line posts, terminal posts, rails, pickets, panels, gates, hardware, hinges, latches, post caps, and grade following (racked versus stepped). Note fence height, material, and where the line runs relative to the property, since disputes are common. Gates deserve their own attention because they are the part that fails.`,

  decks: `This is a deck builder. Structure matters more than surface, and documentation should show it: footings, depth, posts, beams, joists, joist spacing, ledger attachment, and ledger flashing. Use accurate terms — decking boards, hidden fasteners, picture frame, rim joist, blocking, railing posts, balusters, stair stringers, risers, and treads. Ledger flashing and footing depth are the two things inspectors look at, so photograph and describe them specifically. Note material — pressure treated, cedar, composite — since maintenance expectations differ.`,

  solar: `This is a solar installer. The job is part roofing, part electrical, and documentation should cover both. Use accurate terms: array layout, racking, rails, mounts, flashing, modules, module count, inverter or microinverters, rapid shutdown, conduit run, combiner, disconnect, main service panel, interconnection, and production meter. Roof penetrations and their flashing are the highest-risk detail and should always be described. Note inspection and permission to operate as distinct milestones, since they gate the system going live.`,

  siding: `This is a siding contractor. What goes behind the siding determines whether it performs, so document house wrap, flashing, and any sheathing repair before the covering goes on. Use the right terms: house wrap, weather barrier, starter strip, J-channel, corner posts, courses, laps, soffit, fascia, frieze board, and trim. Name the material — vinyl, fiber cement, wood, engineered wood, metal — since installation details differ. Window and door flashing details are worth their own photos and their own description.`,

  gutters: `This is a gutter contractor. Describe the system and how it drains, not just that gutters are present. Use accurate terms: K-style or half-round, seamless, gauge, hangers, spacing, pitch, miters, end caps, outlets, downspouts, elbows, kick-outs, splash blocks, and underground drains. Fascia condition and rot matter because gutters hang on it, so call out repairs. Note where water is being directed, since drainage away from the foundation is the actual point of the job.`,

  drywall: `This is a drywall contractor. Hanging and finishing are separate stages and should read that way. Use the real vocabulary: hang, board, butt joints, screws, corner bead, tape, bed coat, second coat, skim, sanding, level of finish, and texture (knockdown, orange peel, smooth). For repairs, describe the cause and extent of damage along with the patch. Note when an area is ready for primer, since that is the handoff to the next trade.`,

  pressure_washing: `This is a pressure washing or exterior cleaning business. The value is entirely in before-and-after, so condition before cleaning must be described specifically — algae, mildew, oxidation, rust, efflorescence, organic staining, or traffic marks. Use accurate terms: soft wash, surface cleaner, chemical application, dwell time, PSI, downstreaming, and post-treatment. Name the surface — vinyl siding, stucco, brick, concrete, paver, roof, deck — since method and pressure vary by material. Note anything protected or masked during the work.`,

  other: `This is a trade contractor. Write in plain trade language about what was done, what stage the work is at, and what comes next. Describe materials, surfaces, and equipment by their real names. Distinguish preparation, in-progress work, and completed work, since that distinction is what the reader needs.`,
};

/**
 * Returns the curated block for an industry value, or null when the account
 * has no industry set or the value is unrecognized. A null result means no
 * trade block is injected — the base prompt stands on its own.
 */
export function getTradePrompt(industry: string | null | undefined): string | null {
  if (!industry) return null;
  return TRADE_PROMPTS[industry] ?? null;
}