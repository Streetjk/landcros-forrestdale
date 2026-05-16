// Dijkstra pathfinding over the road network in roads.json.
// Coordinates are lat/lng; edge weights are Haversine distances.

function _haversine([lat1, lng1], [lat2, lng2]) {
  const R = 6371000; // metres
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * buildGraph(roads) → adjacency map: nodeId → [{ to, weight }]
 * Respects oneWay edges.
 */
export function buildGraph(roads) {
  const nodeMap = Object.fromEntries(roads.nodes.map(n => [n.id, n]));
  const graph = Object.fromEntries(roads.nodes.map(n => [n.id, []]));

  for (const edge of roads.edges) {
    const a = nodeMap[edge.from];
    const b = nodeMap[edge.to];
    if (!a || !b) continue;
    const w = _haversine(a.latlng, b.latlng);
    graph[edge.from].push({ to: edge.to, weight: w });
    if (!edge.oneWay) graph[edge.to].push({ to: edge.from, weight: w });
  }
  return graph;
}

/**
 * dijkstra(graph, startId, endId) → array of node IDs, or null if unreachable.
 */
export function dijkstra(graph, startId, endId) {
  const dist = {};
  const prev = {};
  // Simple min-heap via sorted insertion on small graphs
  const queue = [{ id: startId, d: 0 }];

  for (const id of Object.keys(graph)) dist[id] = Infinity;
  dist[startId] = 0;

  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const { id, d } = queue.shift();
    if (d > dist[id]) continue;
    if (id === endId) break;

    for (const edge of (graph[id] ?? [])) {
      const nd = d + edge.weight;
      if (nd < dist[edge.to]) {
        dist[edge.to] = nd;
        prev[edge.to] = id;
        queue.push({ id: edge.to, d: nd });
      }
    }
  }

  if (!isFinite(dist[endId])) return null;

  const path = [];
  for (let cur = endId; cur; cur = prev[cur]) path.unshift(cur);
  return path;
}

/**
 * nearestNode(roads, latlng) → node id of the closest node to the given latlng.
 */
export function nearestNode(roads, latlng) {
  let best = null, bestDist = Infinity;
  for (const node of roads.nodes) {
    const d = _haversine(latlng, node.latlng);
    if (d < bestDist) { bestDist = d; best = node.id; }
  }
  return best;
}

/**
 * findRoute(roads, fromLatlng, toLatlng) → array of [lat,lng] waypoints, or null.
 * Finds path: fromLatlng → nearest node → ... → nearest node to toLatlng → toLatlng
 */
export function findRoute(roads, fromLatlng, toLatlng) {
  const graph  = buildGraph(roads);
  const startId = nearestNode(roads, fromLatlng);
  const endId   = nearestNode(roads, toLatlng);

  const nodeIds = dijkstra(graph, startId, endId);
  if (!nodeIds) return null;

  const nodeMap = Object.fromEntries(roads.nodes.map(n => [n.id, n]));
  return [
    fromLatlng,
    ...nodeIds.map(id => nodeMap[id].latlng),
    toLatlng,
  ];
}
