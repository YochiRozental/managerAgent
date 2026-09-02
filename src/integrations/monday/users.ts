import { mondayClient } from "./client.js";

export interface MondayUser {
  id: string;
  name: string;
  email: string;
}

export async function listMondayUsers(): Promise<MondayUser[]> {
  const result = await mondayClient.request<{ users: MondayUser[] }>(`query { users(limit: 100) { id name email } }`);
  return result.users;
}

/** Finds team members whose name contains the query (case-insensitive), for resolving a Hebrew first name to a Monday user id. */
export async function findUsersByName(query: string): Promise<MondayUser[]> {
  const users = await listMondayUsers();
  const needle = query.trim().toLowerCase();
  return users.filter((u) => u.name.toLowerCase().includes(needle));
}
