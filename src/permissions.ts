import { newTrie } from "shiro-trie";

export function permissionGroupsAllow(
  permissionGroups: string[][],
  required: string,
): boolean {
  return permissionGroups.some((group) => {
    const permissions = newTrie();
    permissions.add(...group);
    return permissions.check(required);
  });
}
