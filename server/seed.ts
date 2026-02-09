import { db } from "./db";
import { projects, media, tasks } from "@shared/schema";
import { sql } from "drizzle-orm";

const seedProjects = [
  {
    name: "Downtown Office Renovation",
    description: "Complete interior renovation of a 5-story commercial office building including electrical, plumbing, HVAC upgrades and modern glass facade installation.",
    status: "active" as const,
    address: "450 Market St, San Francisco, CA 94105",
    latitude: 37.7910,
    longitude: -122.3990,
    color: "#3B82F6",
  },
  {
    name: "Highway 101 Repaving",
    description: "Major road maintenance project covering 12 miles of highway surface repaving, guardrail replacement, and drainage improvements.",
    status: "active" as const,
    address: "Highway 101, Palo Alto, CA 94301",
    latitude: 37.4419,
    longitude: -122.1430,
    color: "#F59E0B",
  },
  {
    name: "Riverside Residential Complex",
    description: "New construction of a 24-unit residential complex with underground parking, community facilities, and landscaping.",
    status: "on_hold" as const,
    address: "1200 River Rd, Sacramento, CA 95814",
    latitude: 38.5816,
    longitude: -121.4944,
    color: "#10B981",
  },
  {
    name: "City Hall Electrical Inspection",
    description: "Annual electrical system inspection and compliance certification for the main City Hall building and adjacent annex.",
    status: "completed" as const,
    address: "1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102",
    latitude: 37.7793,
    longitude: -122.4193,
    color: "#8B5CF6",
  },
  {
    name: "Waterfront Park Plumbing",
    description: "Installation of new water supply and drainage systems for the waterfront park restroom facilities and fountain infrastructure.",
    status: "active" as const,
    address: "Pier 39, San Francisco, CA 94133",
    latitude: 37.8087,
    longitude: -122.4098,
    color: "#EF4444",
  },
];

const seedMedia = [
  { projectIndex: 0, filename: "seed-renovation-1.png", originalName: "facade-installation.png", mimeType: "image/png", url: "/images/seed-renovation-1.png", caption: "Glass facade panels being installed on the west side", tags: ["facade", "exterior", "progress"] },
  { projectIndex: 0, filename: "seed-construction-1.png", originalName: "foundation-work.png", mimeType: "image/png", url: "/images/seed-construction-1.png", caption: "Foundation reinforcement completed on level B2", tags: ["foundation", "structural"] },
  { projectIndex: 1, filename: "seed-road-1.png", originalName: "asphalt-paving.png", mimeType: "image/png", url: "/images/seed-road-1.png", caption: "Fresh asphalt layer on northbound section mile 4-6", tags: ["paving", "asphalt", "progress"] },
  { projectIndex: 3, filename: "seed-electrical-1.png", originalName: "electrical-panel.png", mimeType: "image/png", url: "/images/seed-electrical-1.png", caption: "Main electrical panel inspection - all circuits tested", tags: ["electrical", "inspection", "compliance"] },
  { projectIndex: 4, filename: "seed-plumbing-1.png", originalName: "pipe-installation.png", mimeType: "image/png", url: "/images/seed-plumbing-1.png", caption: "Water supply rough-in for restroom facility A", tags: ["plumbing", "pipes", "installation"] },
];

const seedTasks = [
  { projectIndex: 0, title: "Complete facade panel installation - Phase 2", priority: "high" as const, status: "in_progress" as const },
  { projectIndex: 0, title: "Inspect HVAC ductwork on floors 3-5", priority: "medium" as const, status: "todo" as const },
  { projectIndex: 0, title: "Order additional glass panels for east side", priority: "high" as const, status: "done" as const },
  { projectIndex: 1, title: "Mark lane closures for mile 7-9", priority: "high" as const, status: "todo" as const },
  { projectIndex: 1, title: "Complete drainage channel repairs", priority: "medium" as const, status: "in_progress" as const },
  { projectIndex: 2, title: "Submit revised foundation plans", priority: "high" as const, status: "todo" as const },
  { projectIndex: 3, title: "File compliance report with city", priority: "low" as const, status: "done" as const },
  { projectIndex: 4, title: "Pressure test water supply lines", priority: "medium" as const, status: "todo" as const },
  { projectIndex: 4, title: "Install drainage catch basins", priority: "high" as const, status: "in_progress" as const },
];

export async function seedDatabase() {
  try {
    const existingProjects = await db.select({ id: projects.id }).from(projects).limit(1);
    if (existingProjects.length > 0) {
      console.log("Database already seeded, skipping...");
      return;
    }

    console.log("Seeding database...");

    const createdProjects = await db.insert(projects).values(seedProjects).returning();
    console.log(`Created ${createdProjects.length} projects`);

    const mediaValues = seedMedia.map((m) => ({
      projectId: createdProjects[m.projectIndex].id,
      filename: m.filename,
      originalName: m.originalName,
      mimeType: m.mimeType,
      url: m.url,
      caption: m.caption,
      tags: m.tags,
      latitude: createdProjects[m.projectIndex].latitude,
      longitude: createdProjects[m.projectIndex].longitude,
    }));
    const createdMedia = await db.insert(media).values(mediaValues).returning();
    console.log(`Created ${createdMedia.length} media items`);

    const taskValues = seedTasks.map((t) => ({
      projectId: createdProjects[t.projectIndex].id,
      title: t.title,
      priority: t.priority,
      status: t.status,
    }));
    const createdTasks = await db.insert(tasks).values(taskValues).returning();
    console.log(`Created ${createdTasks.length} tasks`);

    console.log("Database seeding complete!");
  } catch (error) {
    console.error("Error seeding database:", error);
  }
}
