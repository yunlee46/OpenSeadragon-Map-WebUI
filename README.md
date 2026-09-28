# OpenSeadragon Map WebUI

A self-hosted [OpenSeadragon](https://openseadragon.github.io/) deep-zoom viewer with an admin panel.

- **Maps are canvases.** Place one or more images on a map, drag them into position and resize them.
- **Image library.** Upload normal images (JPG, PNG, TIFF, WebP…) and the server tiles them into Deep Zoom (DZI) with libvips. Or upload a `.zip` of an image you've already tiled (`name.dzi` + `name_files/`).
- **Hitboxes.** Rectangles or polygons that take the viewer to another map when clicked. The Back button and browser history work.
- **Notes (annotations).** Rectangles or polygons that show a title and text when clicked.
- **Blender-style image list.** Nested groups you can collapse, drag and drop, and hide with an eye toggle. List order is stacking order, and a group can be moved on the canvas as one piece.
- **Image types** (background, object, character, plus your own) decide which images fade in focus mode and zoom-reveal. Each image on a map can override its type or always/never fade.
- **Focus mode.** Pick an image and the view flies to it while the other images fade. The fade amount is adjustable, with a default set in the admin.
- **Zoom-reveal.** As you zoom into an image it turns transparent, revealing the one behind it, then the next one, layer by layer.
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

Everything (the SQLite database, tiles and thumbnails) lives in the `osd-data` Docker volume, so it survives updates.

### On a UGREEN NAS (or Synology, Unraid, Portainer…)

1. In the Docker app, create a new **Project** (compose) and paste in `docker-compose.yml`.
2. Either add a `.env` file with `ADMIN_PASSWORD` and `SESSION_SECRET`, or replace those two `${…}` values in the compose file with the real values.
3. Deploy it. The NAS pulls the image from GitHub.

**Updates:** the NAS compares the `:latest` image it runs with the one on GitHub. After a new push has finished building (see the repo's **Actions** tab), the NAS shows an update for the container. Applying it pulls the new image and recreates the container, and your data volume is kept.

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
| `MAX_UPLOAD_MB` | `4096` | Largest upload allowed |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy, so login rate-limiting sees real client IPs |

### Behind a reverse proxy

Large uploads need a raised body-size limit. For nginx, use `client_max_body_size 4g;` and `proxy_request_buffering off;`.

### Backups

```bash
docker run --rm -v openseadragon-map-webui_osd-data:/data -v "$PWD":/backup alpine tar czf /backup/map-webui-backup.tgz -C /data .
```

The volume name is `<folder>_osd-data`. Check it with `docker volume ls`.

## Using the admin panel

1. **Images → upload.** Tiling runs in the background, one image at a time. Very large images can take a few minutes. Give each image a **type** from the dropdown on its card.
2. **Types & settings.** Create, rename and delete types, choose whether each type fades in focus mode and zoom-reveal, and set the default fade amount for focus mode.
3. **Maps → Create map.** This opens the editor.
4. In the editor's **Images on this map** section:
   - The three icon buttons are **add from library** (pick from thumbnails), **upload** (new files are uploaded, tiled and placed automatically) and **new group**.
   - Drag rows to reorder them or move them into groups. Higher in the list is drawn on top. The eye icon hides an image or group, which also hides it in the public viewer.
   - **Right-click** an image or group, in the list or on the canvas, to focus it, rename it, set its type for this map only, set it to always or never fade, set the zoom at which it starts to zoom-reveal, move it into a new group or remove it. Deleting a group removes everything inside it from the map.
   - With **Move (M)**, drag an image to move it. Select a group first to drag the whole group.
5. **Preview** section: try focus mode (double-click an image or press **F**) and zoom-reveal while editing. "Make this the default" saves the current fade amount for everyone.
6. **Hitboxes and notes**: pick **Hitbox** or **Note** in the toolbar, then draw with **Rect (R)** (drag) or **Polygon (P)**: click points, then click the first point, double-click or press Enter to close the shape. With **Select (S)**, click a shape to edit it, drag it to move it or drag its handles to reshape it.
7. **Save** (or Ctrl+S). Nothing is saved until you do.
8. Mark one map as the **default**. It's the one the viewer opens first.

In the viewer, **☰ Images** opens a panel listing the map's images with thumbnails. Click an image to fly to it, and turn on focus mode or zoom-reveal from the panel.

Deleting an image removes it from every map that uses it and deletes its tiles. Deleting a map leaves hitboxes that pointed to it unlinked. Deleting a type leaves its images with no type.

Shapes use map coordinates, not image coordinates. If you move an image after drawing shapes on top of it, move the shapes too.

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
  maptree.js   Loads and saves a map's nested image groups
public/js/     Viewer, shared SVG overlay, image-tree helpers, fade controller (focus + zoom-reveal),
               outliner (image list) and context menu
public/admin/  Admin pages and the map editor
```
