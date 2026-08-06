import { describe, expect, it } from "vitest";
import { buildVtexCategoryFilterOptions, resolveVtexCategoryFacetValue, type VtexCategoryTreeNode } from "./vtex.client.js";

const TREE: VtexCategoryTreeNode[] = [
  {
    id: 6,
    name: "BANHEIRO",
    children: [
      {
        id: 13,
        name: "Torneiras e Misturadores",
        children: [{ id: 43, name: "Misturador para Banheiro" }],
      },
    ],
  },
  {
    id: 7,
    name: "COZINHA",
    children: [
      {
        id: 23,
        name: "Torneiras e Misturadores",
        children: [{ id: 92, name: "Torneira para Cozinha" }],
      },
    ],
  },
];

describe("VTEX category filters", () => {
  it("builds filter values with the full ancestor id path for category and subcategory levels", () => {
    expect(buildVtexCategoryFilterOptions(TREE)).toEqual([
      { id: "6", name: "BANHEIRO" },
      { id: "6/13", name: "BANHEIRO > Torneiras e Misturadores" },
      { id: "6/13/43", name: "BANHEIRO > Torneiras e Misturadores > Misturador para Banheiro" },
      { id: "7", name: "COZINHA" },
      { id: "7/23", name: "COZINHA > Torneiras e Misturadores" },
      { id: "7/23/92", name: "COZINHA > Torneiras e Misturadores > Torneira para Cozinha" },
    ]);
  });

  it("resolves legacy numeric category ids to the VTEX Search facet path", () => {
    expect(resolveVtexCategoryFacetValue("6", TREE)).toBe("6");
    expect(resolveVtexCategoryFacetValue("13", TREE)).toBe("6/13");
    expect(resolveVtexCategoryFacetValue("43", TREE)).toBe("6/13/43");
    expect(resolveVtexCategoryFacetValue("/6/13/43/", TREE)).toBe("6/13/43");
    expect(resolveVtexCategoryFacetValue("999", TREE)).toBe("999");
  });
});
