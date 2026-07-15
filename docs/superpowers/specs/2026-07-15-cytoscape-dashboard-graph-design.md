# Cytoscape Dashboard Graph Design

## Goal

Replace the Dashboard's hand-written SVG graph renderer with Cytoscape.js so
entity names remain readable and the graph has robust layout and interaction.

## Scope

- Load the pinned Cytoscape.js 3.34.0 UMD build from jsDelivr in the Dashboard
  page. The Worker bundle does not include the library.
- Keep the existing authenticated Dashboard graph API and its user-only scope.
- Translate returned entities into labelled nodes and relationships into labelled
  directed edges.
- Use Cytoscape's animated `cose` layout, pan, zoom, and node dragging.
- Size rounded-rectangle nodes from wrapped labels instead of truncating entity
  names or drawing fixed-radius circles.
- Preserve the existing node detail panel. Selecting a node shows its existing
  type/name detail; selecting the background hides it.
- Preserve the current user/agent guidance and remote read-only behavior.

## Failure And Accessibility Behavior

- If the CDN script is unavailable, the graph canvas displays an explicit
  library-load error and the status announces that the graph cannot be shown.
- Existing graph status remains an `aria-live="polite"` region.
- Cytoscape's visible labels provide the entity name and relationship predicate;
  the detail panel supplies the selected entity's full text.

## Testing

- Rendered-page tests assert the pinned CDN URL, Cytoscape initialisation, and
  removal of the hand-written SVG construction contract.
- Browser verification against the retained four-node/four-edge remote probe
  confirms the read-only banner, graph status, generated Cytoscape canvas, and
  complete labels.

## Out Of Scope

- Changing graph storage, API contracts, entity inference, or relationship
  extraction.
- Adding an external graph database, graph editing, or multi-hop traversal.
- Bundling Cytoscape.js into the Worker.
