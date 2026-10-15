-- Existing scene tables inherited broad anonymous table grants. Their
-- member-only RLS currently blocks anonymous reads, but defence in depth
-- requires denying table access independently of RLS.
-- Only the narrow, share-code-checked preview RPC remains anon-executable.
-- Server-managed staff CRUD uses the service-role database connection.
revoke all privileges on table
  public.scenes,
  public.scene_objects,
  public.scripts
from anon;
