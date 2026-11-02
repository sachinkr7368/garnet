import { describe, expect, it } from "vitest";
import {
  absoluteKey, actionDefAt, associationModelAt, buildLocaleIndex, defaultLocale, enclosingDef, factoryModelAt, i18nCalls, i18nKeyAt, lookupKey, modelFile,
  parseLocaleYaml, partialAt, resolvePartial, routeTargetAt, viewsForAction,
} from "../railsnav";

const at = (line: string, needle: string) => line.indexOf(needle) + 1;

describe("partials", () => {
  it.each([
    ['<%= render "form", post: @post %>', "form", "form"],
    ["<%= render 'shared/header' %>", "header", "shared/header"],
    ['<%= render partial: "comments/comment", collection: @comments %>', "comment\"", "comments/comment"],
    ["<%= render(:partial => 'row') %>", "row", "row"],
    ["<%= render @posts %>", "posts", "posts/post"],
    ["<%= render @post %>", "post", "posts/post"],
  ])("%s", (line, needle, name) => expect(partialAt(line, at(line, needle))).toBe(name));

  it("ignores other strings", () => {
    const line = '<%= link_to "form", render_path %>';
    expect(partialAt(line, at(line, "form"))).toBeNull();
    const line2 = '<%= render "form", title: "Edit" %>';
    expect(partialAt(line2, at(line2, "Edit"))).toBeNull();
  });

  const files = [
    "app/views/posts/_form.html.erb",
    "app/views/posts/_form.json.jbuilder",
    "app/views/posts/index.html.erb",
    "app/views/shared/_header.html.haml",
    "app/views/application/_flash.html.erb",
    "app/views/admin/posts/_row.html.erb",
    "app/views/posts/drafts/_form.html.erb",
  ];

  it("resolves relative to the view folder, the controller's views and application/", () => {
    expect(resolvePartial("form", "app/views/posts/index.html.erb", files)).toEqual(["app/views/posts/_form.html.erb", "app/views/posts/_form.json.jbuilder"]);
    expect(resolvePartial("form", "app/controllers/posts_controller.rb", files)[0]).toBe("app/views/posts/_form.html.erb");
    expect(resolvePartial("row", "app/views/admin/posts/edit.html.erb", files)).toEqual(["app/views/admin/posts/_row.html.erb"]);
    expect(resolvePartial("shared/header", "app/views/posts/index.html.erb", files)).toEqual(["app/views/shared/_header.html.haml"]);
    expect(resolvePartial("flash", "app/views/posts/index.html.erb", files)).toEqual(["app/views/application/_flash.html.erb"]);
    expect(resolvePartial("missing", "app/views/posts/index.html.erb", files)).toEqual([]);
  });
});

describe("i18n keys", () => {
  it("finds literal keys in t / translate / I18n.t calls", () => {
    const text = '<h1><%= t(".title") %></h1>\n<%= I18n.t("posts.count", count: 2) %>\n<%= translate "a.b" %>\n<%= format(".x") %>\n<%= t("x.y", default: "Y") %>';
    expect(i18nCalls(text).map((c) => [c.key, c.line, c.hasDefault])).toEqual([
      [".title", 1, false],
      ["posts.count", 2, false],
      ["a.b", 3, false],
      ["x.y", 5, true],
    ]);
    const line = '<%= t("posts.count") %>';
    expect(i18nKeyAt(line, at(line, "count"))).toBe("posts.count");
    expect(i18nKeyAt(line, 0)).toBeNull();
  });

  it("expands lazy keys from views, partials and controller actions", () => {
    expect(absoluteKey(".title", "app/views/posts/index.html.erb")).toBe("posts.index.title");
    expect(absoluteKey(".save", "app/views/admin/posts/_form.html.erb")).toBe("admin.posts.form.save");
    expect(absoluteKey(".created", "app/controllers/admin/posts_controller.rb", "create")).toBe("admin.posts.create.created");
    expect(absoluteKey(".x", "app/models/post.rb")).toBeNull();
    expect(absoluteKey("a.b", "app/models/post.rb")).toBe("a.b");
  });

  it("finds the enclosing action", () => {
    const lines = ["class PostsController < ApplicationController", "  def create", "    redirect_to posts_path, notice: t('.created')", "  end", "end"];
    expect(enclosingDef(lines, 2)).toBe("create");
    expect(enclosingDef(lines, 0)).toBeNull();
  });

  const en = `# comment
en:
  hello: "Hello world"
  posts:
    index:
      title: Listing posts # trailing comment
      empty: 'It''s empty'
    intro: |
      Line one
      Line two
    folded: >
      a
      b
  "quoted.key": Quoted
  days:
    - Mon
    - Tue
  defaults: &defaults
    ok: OK
`;

  it("parses locale YAML into flat keys with lines", () => {
    const map = parseLocaleYaml(en);
    expect(map.get("en.hello")).toEqual({ line: 3, value: "Hello world" });
    expect(map.get("en.posts.index.title")).toEqual({ line: 6, value: "Listing posts" });
    expect(map.get("en.posts.index.empty")?.value).toBe("It's empty");
    expect(map.get("en.posts.intro")?.value).toBe("Line one\nLine two");
    expect(map.get("en.posts.folded")?.value).toBe("a b");
    expect(map.get("en.quoted.key")?.value).toBe("Quoted");
    expect(map.get("en.days")?.value).toBe("[Mon, Tue]");
    expect(map.get("en.defaults.ok")?.value).toBe("OK");
  });

  it("looks keys up per locale, treating subtrees as present", () => {
    const index = buildLocaleIndex([
      { path: "config/locales/en.yml", text: en },
      { path: "config/locales/de.yml", text: "de:\n  hello: Hallo\n" },
    ]);
    expect(lookupKey(index, "en", "posts.index.title")).toMatchObject({ path: "config/locales/en.yml", line: 6 });
    expect(lookupKey(index, "de", "hello")).toMatchObject({ value: "Hallo" });
    expect(lookupKey(index, "en", "posts.index")).toBe("namespace");
    expect(lookupKey(index, "de", "posts.index.title")).toBeNull();
    expect(defaultLocale("module Blog\n  class Application\n    config.i18n.default_locale = :de\n")).toBe("de");
    expect(defaultLocale("")).toBe("en");
  });
});

describe("routes.rb", () => {
  const routes = `Rails.application.routes.draw do
  root "pages#home"
  get "about" => "pages#about"
  resources :posts, only: [:index, :show] do
    member do
      get :preview
    end
    resources :comments
  end
  resource :profile
  namespace :admin do
    resources :users
    get "stats", to: "dashboard#stats"
  end
  scope "/api", module: :api do
    resources :items, controller: "products"
  end
end`.split("\n");
  const target = (line: number, needle: string) => routeTargetAt(routes, line, routes[line].indexOf(needle) + 1);

  it("maps strings, resources and member routes to controllers and actions", () => {
    expect(target(1, "pages#home")).toEqual({ controller: "pages", action: "home" });
    expect(target(2, "pages#about")).toEqual({ controller: "pages", action: "about" });
    expect(target(3, "posts")).toEqual({ controller: "posts" });
    expect(target(3, "show")).toEqual({ controller: "posts", action: "show" });
    expect(target(5, "preview")).toEqual({ controller: "posts", action: "preview" });
    expect(target(7, "comments")).toEqual({ controller: "comments" });
    expect(target(9, "profile")).toEqual({ controller: "profiles" });
    expect(target(11, "users")).toEqual({ controller: "admin/users" });
    expect(target(12, "dashboard#stats")).toEqual({ controller: "admin/dashboard", action: "stats" });
    expect(target(15, "items")).toEqual({ controller: "api/products" });
    expect(target(2, "about\"")).toBeNull();
  });
});

describe("actions, associations and factories", () => {
  it("maps a controller action to its views", () => {
    const files = ["app/views/posts/index.html.erb", "app/views/posts/index.json.jbuilder", "app/views/posts/show.html.erb", "app/views/admin/posts/index.html.erb"];
    expect(actionDefAt("  def index", 7)).toBe("index");
    expect(actionDefAt("  def index", 2)).toBeNull();
    expect(viewsForAction("app/controllers/posts_controller.rb", "index", files)).toEqual(["app/views/posts/index.html.erb", "app/views/posts/index.json.jbuilder"]);
    expect(viewsForAction("app/controllers/admin/posts_controller.rb", "index", files)).toEqual(["app/views/admin/posts/index.html.erb"]);
  });

  it.each([
    ["  has_many :comments, dependent: :destroy", "comments", "comment"],
    ["  belongs_to :author, class_name: \"Admin::User\"", "author", "admin/user"],
    ["  has_one :profile", "profile", "profile"],
    ["  has_many :people", "people", "person"],
    ["  has_and_belongs_to_many :categories", "categories", "category"],
    ["  belongs_to :owner, class_name: 'User', optional: true", "owner", "user"],
  ])("%s", (line, needle, model) => expect(associationModelAt(line, at(line, needle))).toBe(model));

  it.each([
    ["  factory :user do", "user", "user"],
    ["  factory :admin, class: \"User\" do", "admin", "user"],
    ["  factory :admin_post, class: Admin::Post do", "admin_post", "admin/post"],
    ["  factory :draft, class: :post do", "draft", "post"],
  ])("%s", (line, needle, model) => expect(factoryModelAt(line, at(line, needle))).toBe(model));

  it("finds model files, including namespaced ones", () => {
    const files = ["app/models/user.rb", "app/models/admin/post.rb"];
    expect(modelFile("user", files)).toBe("app/models/user.rb");
    expect(modelFile("post", files)).toBe("app/models/admin/post.rb");
    expect(modelFile("ghost", files)).toBeNull();
  });
});
