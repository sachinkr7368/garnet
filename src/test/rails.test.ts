import { describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { parseExpandedRoutes, pluralize, relatedFiles, resourceOf, singularize } from "../rails";

describe("inflection", () => {
  it.each([
    ["post", "posts"],
    ["address", "addresses"],
    ["box", "boxes"],
    ["match", "matches"],
    ["category", "categories"],
    ["day", "days"],
    ["person", "people"],
    ["child", "children"],
  ])("%s ↔ %s", (one, many) => {
    expect(pluralize(one)).toBe(many);
    expect(singularize(many)).toBe(one);
  });

  it("leaves singular words ending in ss alone", () => expect(singularize("class")).toBe("class"));
});

describe("resourceOf", () => {
  it.each([
    ["app/models/post.rb", "post"],
    ["app/models/admin/user.rb", "admin/user"],
    ["app/controllers/posts_controller.rb", "post"],
    ["app/controllers/admin/users_controller.rb", "admin/user"],
    ["app/views/posts/index.html.erb", "post"],
    ["app/helpers/categories_helper.rb", "category"],
    ["app/jobs/post_job.rb", "post"],
    ["spec/models/post_spec.rb", "post"],
    ["spec/requests/posts_spec.rb", "post"],
    ["test/controllers/posts_controller_test.rb", "post"],
    ["spec/factories/posts.rb", "post"],
    ["db/migrate/20240101000000_create_posts.rb", "post"],
    ["db/migrate/20240101000000_add_title_to_posts.rb", "post"],
    ["config/routes.rb", null],
  ])("%s → %s", (path, res) => expect(resourceOf(path)).toBe(res));
});

describe("relatedFiles", () => {
  const files = [
    "app/models/post.rb",
    "app/controllers/posts_controller.rb",
    "app/views/posts/index.html.erb",
    "app/views/posts/show.html.erb",
    "app/helpers/posts_helper.rb",
    "spec/models/post_spec.rb",
    "test/controllers/posts_controller_test.rb",
    "spec/factories/posts.rb",
    "db/migrate/20240101000000_create_posts.rb",
    "app/models/comment.rb",
    "app/views/comments/index.html.erb",
  ];

  it("finds every related file of a model, ordered by kind", () => {
    expect(relatedFiles("app/models/post.rb", files).map((r) => [r.kind, r.path])).toEqual([
      ["Controller", "app/controllers/posts_controller.rb"],
      ["View", "app/views/posts/show.html.erb"],
      ["View", "app/views/posts/index.html.erb"],
      ["Helper", "app/helpers/posts_helper.rb"],
      ["Spec", "spec/models/post_spec.rb"],
      ["Test", "test/controllers/posts_controller_test.rb"],
      ["Factory / fixture", "spec/factories/posts.rb"],
      ["Migration", "db/migrate/20240101000000_create_posts.rb"],
    ]);
  });

  it("goes from a view back to the model and controller", () => {
    const kinds = relatedFiles("app/views/posts/show.html.erb", files).map((r) => r.path);
    expect(kinds).toContain("app/models/post.rb");
    expect(kinds).toContain("app/controllers/posts_controller.rb");
    expect(kinds).not.toContain("app/models/comment.rb");
  });

  it("returns nothing for files outside the Rails layout", () => expect(relatedFiles("lib/tasks/a.rake", files)).toEqual([]));

  it("treats regex characters in paths literally", () => {
    const odd = ["app/models/c++.rb", "app/models/cxx.rb", "spec/models/c++_spec.rb", "app/models/a(b.rb", "spec/models/a(b_spec.rb"];
    expect(relatedFiles("app/models/c++.rb", odd).map((r) => r.path)).toEqual(["spec/models/c++_spec.rb"]);
    expect(relatedFiles("app/models/a(b.rb", odd).map((r) => r.path)).toEqual(["spec/models/a(b_spec.rb"]);
  });
});

describe("routes", () => {
  it("parses bin/rails routes --expanded", () => {
    const out = `--[ Route 1 ]-------------\nPrefix            | posts\nVerb              | GET\nURI               | /posts(.:format)\nController#Action | posts#index\n--[ Route 2 ]-------------\nPrefix            | \nVerb              | POST\nURI               | /posts(.:format)\nController#Action | posts#create\n`;
    expect(parseExpandedRoutes(out)).toEqual([
      { name: "posts", verb: "GET", uri: "/posts(.:format)", action: "posts#index" },
      { name: "", verb: "POST", uri: "/posts(.:format)", action: "posts#create" },
    ]);
  });
});
