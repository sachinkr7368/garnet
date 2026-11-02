import { describe, expect, it } from "vitest";
import { pluralize, singularize, underscore } from "../inflect";

describe("Rails default inflections", () => {
  it.each([
    ["post", "posts"],
    ["address", "addresses"],
    ["box", "boxes"],
    ["match", "matches"],
    ["wish", "wishes"],
    ["category", "categories"],
    ["query", "queries"],
    ["day", "days"],
    ["person", "people"],
    ["salesperson", "salespeople"],
    ["man", "men"],
    ["child", "children"],
    ["sex", "sexes"],
    ["move", "moves"],
    ["zombie", "zombies"],
    ["mouse", "mice"],
    ["louse", "lice"],
    ["ox", "oxen"],
    ["axis", "axes"],
    ["testis", "testes"],
    ["octopus", "octopi"],
    ["virus", "viri"],
    ["alias", "aliases"],
    ["status", "statuses"],
    ["bus", "buses"],
    ["buffalo", "buffaloes"],
    ["tomato", "tomatoes"],
    ["medium", "media"],
    ["datum", "data"],
    ["analysis", "analyses"],
    ["basis", "bases"],
    ["diagnosis", "diagnoses"],
    ["knife", "knives"],
    ["wolf", "wolves"],
    ["half", "halves"],
    ["hive", "hives"],
    ["objective", "objectives"],
    ["matrix", "matrices"],
    ["vertex", "vertices"],
    ["index", "indices"],
    ["quiz", "quizzes"],
    ["shoe", "shoes"],
    ["movie", "movies"],
    ["crisis", "crises"],
    ["database", "databases"],
    ["blog_post", "blog_posts"],
    ["Person", "People"],
  ])("%s ↔ %s", (one, many) => {
    expect(pluralize(one)).toBe(many);
    expect(singularize(many)).toBe(one);
  });

  it.each(["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "jeans", "police", "news_fish"])("%s is uncountable", (w) => {
    if (w === "news_fish") {
      expect(pluralize(w)).toBe("news_fishes");
      return;
    }
    expect(pluralize(w)).toBe(w);
    expect(singularize(w)).toBe(w);
  });

  it("keeps words that are already in the target form", () => {
    expect(pluralize("posts")).toBe("posts");
    expect(pluralize("people")).toBe("people");
    expect(singularize("class")).toBe("class");
    expect(singularize("news")).toBe("news");
    expect(singularize("status")).toBe("status");
    expect(pluralize("")).toBe("");
  });

  it("underscores class names", () => {
    expect(underscore("Admin::BlogPost")).toBe("admin/blog_post");
    expect(underscore("HTMLParser")).toBe("html_parser");
    expect(underscore("User")).toBe("user");
  });
});
