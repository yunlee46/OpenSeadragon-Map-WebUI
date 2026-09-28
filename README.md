# OpenSeadragon Map WebUI

A self-hosted [OpenSeadragon](https://openseadragon.github.io/) deep-zoom viewer with an admin panel.

- **Maps are canvases.** Place one or more images on a map, drag them into position and resize them.
- **Image library.** Upload normal images (JPG, PNG, TIFF, WebP…) and the server tiles them into Deep Zoom (DZI) with libvips. Or upload a `.zip` of an image you've already tiled (`name.dzi` + `name_files/`). **Replace file** swaps in a new version and keeps every placement, type and hitbox that uses it.
- **Hitboxes.** Rectangles or polygons that open another map (optionally focusing a specific image there) or a web page. Breadcrumbs, the Back button and browser history work.
- **Notes (annotations).** Rectangles or polygons that show a title, a picture and formatted text (bold, italics, links, lists) when clicked.
- **Shapes move with their image.** A hitbox or note can be attached to an image or group, so it moves, resizes, hides and fades along with it.
- **Blender-style image list.** Nested groups you can collapse, drag and drop, and hide with an eye toggle. List order is stacking order, and a group can be moved on the canvas as one piece.
- **Image types** (background, object, character, plus your own) decide which images fade in focus mode and zoom-reveal. Each image on a map can override its type or always/never fade.
- **Focus mode.** Pick an image and the view flies to it while the other images fade. The fade amount is adjustable, with a default set in the admin.
- **Zoom-reveal.** As you zoom into an image it turns transparent, revealing the one behind it, then the next one, layer by layer.
- **Drafts and publishing.** Editing saves a draft. Visitors only see changes after you **Publish**, and you can preview a draft or throw it away.
- **Undo/redo** in the editor (Ctrl+Z / Ctrl+Y).
- **Starting view per map**, used when the map opens and by the home button.
- **Search** across all published maps (map names, image names, notes, hitbox labels). **Share links** reopen the exact view, including a focused image.
- **Planner.** A to-do list of images you still need, with notes, reference images, status, priority, type and a planned map/group. **Add image** on an item uploads the finished image into the library.
- **Backup and restore** of everything from the admin panel.
- **Phone friendly.** Compact controls, and press and hold a hitbox to see where it goes.
- **Standard OpenSeadragon viewing:** zoom, pan, navigator minimap, rotation and full screen. Add `?debug=1` to the viewer URL to see tile borders and pyramid levels.

## Running with Docker

Every push to `main` builds a new image with GitHub Actions and publishes it as
`ghcr.io/yunlee46/openseadragon-map-webui:latest` (Intel/x86-64).

```bash
cp .env.example .env        # then edit .env: set ADMIN_PASSWORD and SESSION_SECRET
docker compose up -d
```

- Viewer: http://localhost:8080
- Admin: http://localhost:8080/admin/

Everything (the SQLite database, tiles, thumbnails and planner reference images) lives in the `osd-data` Docker volume, so it survives updates.

### On a UGREEN NAS (or Synology, Unraid, Portainer…)

1. In the Docker app, create a new **Project** (compose) and paste in `docker-compose.yml`.
2. Either add a `.env` file with `ADMIN_PASSWORD` and `SESSION_SECRET`, or replace those two `${…}` values in the compose file with the real values.
3. Deploy it. The NAS pulls the image from GitHub.

**Updates:** the NAS compares the `:latest` image it runs with the one on GitHub. After a new push has finished building (see the repo's **Actions** tab), the NAS shows an update for the container. Applying it pulls the new image and recreates the container, and your data volume is kept. Database changes are applied automatically when the new version starts.

### Updating by hand

```bash
docker compose pull
docker compose up -d
```

### Testing local code changes

To build from this folder instead of pulling from GitHub:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### Publishing a new version

Push to `main` and the image is rebuilt automatically. To also publish a numbered version, push a tag:

```bash
git tag v1.1.0
git push origin v1.1.0
```

This publishes `:1.1.0` alongside `:latest`. Use a numbered tag in the compose file if you want to pin a version and only update on purpose.

### Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `ADMIN_USER` | `admin` | Admin username |
| `ADMIN_PASSWORD` | — (required) | Admin password |
| `SESSION_SECRET` | — (required) | Random string that signs login cookies (`openssl rand -hex 32`) |
| `SESSION_HOURS` | `24` | How long a login lasts |
| `MAX_UPLOAD_MB` | `4096` | Largest upload allowed (also the largest backup you can restore) |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy, so login rate-limiting sees real client IPs |

### Behind a reverse proxy

Large uploads need a raised body-size limit. For nginx, use `client_max_body_size 4g;` and `proxy_request_buffering off;`.

### Backups

Use **Types & settings → Backup & restore** in the admin panel.

- **Download backup** gives one zip with everything.
- **Restore from backup** replaces all data with a backup and restarts the server. Docker's `restart: unless-stopped` brings it back up. The data from before the restore is kept in a `pre-restore-…` folder inside the volume until the next restore.

If you run the app without Docker, start it again by hand after a restore.

## Using the admin panel

1. **Images → upload.** Tiling runs in the background, one image at a time. Very large images can take a few minutes. Give each image a **type** from the dropdown on its card. Search and filter by name, type, status, or "not on any map".
2. **Planner.** List the images you still need to make. Open an item to add notes, reference images, a planned map and group, and a type. **⤒ Add image** uploads the finished image straight into the library with the item's name and type, and marks the item done. **Link existing** uses an image that's already in the library.
3. **Types & settings.** Create, rename and delete types, choose whether each type fades in focus mode and zoom-reveal, set the default fade amount, and back up or restore everything.
4. **Maps → Create map.** This opens the editor.
5. In the editor's **Images on this map** section:
   - The three icon buttons are **add from library** (images planned for this map are listed first), **upload** (new files are uploaded, tiled and placed automatically) and **new group**.
   - Drag rows to reorder them or move them into groups. Higher in the list is drawn on top. The eye icon hides an image or group, which also hides it in the public viewer.
   - **Right-click** an image or group, in the list or on the canvas, to focus it, rename it, set its type for this map only, set it to always or never fade, set the zoom at which it starts to zoom-reveal, move it into a new group or remove it. Deleting a group removes everything inside it from the map.
   - With **Move (M)**, drag an image to move it. Select a group first to drag the whole group.
6. **Hitboxes and notes**: pick **Hitbox** or **Note** in the toolbar, then draw with **Rect (R)** (drag) or **Polygon (P)**: click points, then click the first point, double-click or press Enter to close the shape. A new shape is attached to the image under it. Change that under **Moves & hides with**. With **Select (S)**, click a shape to edit it, drag it to move it or drag its handles to reshape it.
   - Hitboxes can **open another map** (and focus an image there) or **open a web page**.
   - Note text supports `**bold**`, `*italic*`, `[links](https://…)`, links to other maps like `[City](?map=<map id>)`, and `- ` lists. A note can also show a picture from the library.
7. **Map settings → Starting view**: frame the map the way visitors should first see it and click **Use current view**.
8. **Save** (Ctrl+S) saves the draft. **Undo/redo** with the arrow buttons or Ctrl+Z / Ctrl+Y.
9. **Publish** makes the saved draft visible to visitors. **Preview** shows the draft exactly as visitors will see it. **Discard draft** goes back to the published version.
10. Mark one map as the **default**. It's the one the viewer opens first.

In the viewer, **☰ Images** opens a panel listing the map's images with thumbnails. Click an image to fly to it, and turn on focus mode or zoom-reveal from the panel. **⌕** searches every published map, and **🔗** copies a link to the current view.

Deleting an image removes it from every map that uses it, deletes its tiles, and puts its planner item back to "in progress". Deleting a map leaves hitboxes that pointed to it unlinked. Deleting a type leaves its images with no type.

## Running without Docker

Requires Node.js 20+.

```bash
npm install
ADMIN_PASSWORD=... SESSION_SECRET=... npm start
```

Data goes to `./data` unless `DATA_DIR` is set.

## Layout

```
server/        Express app, SQLite (better-sqlite3) with migrations, tiling (sharp/libvips), zip import (yauzl)
  content.js   Drafts vs. published snapshots, and what the viewer and editor receive
  maptree.js   Loads and saves a map's nested image groups
  routes/      maps (+ search, publish), images, types & settings, planner, backup & restore
public/js/     Viewer, shared SVG overlay, image-tree helpers, fade controller (focus + zoom-reveal),
               outliner (image list), context menu, Markdown for notes
public/admin/  Admin pages, the map editor and the planner
```
