import { describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));

import { createdFiles, generatorArgs, parseGeneratorHelp, parseGeneratorList, splitArgs } from "../generators";

const LIST = `Usage:
  bin/rails generate GENERATOR [args] [options]

General options:
  -h, [--help]     # Print generator's options and usage
  -p, [--pretend]  # Run but do not make any changes

Please choose a generator below.

Rails:
  application_record
  controller
  model
  scaffold

ActiveRecord:
  active_record:application_record
  active_record:multi_db

TestUnit:
  test_unit:channel
`;

const CONTROLLER = `Usage:
  bin/rails generate controller NAME [action action] [options]

Options:
      [--skip-namespace], [--no-skip-namespace]              # Skip namespace (affects only isolated engines)
                                                             # Default: false
      [--skip-routes], [--no-skip-routes]                    # Don't add routes to config/routes.rb.
      [--helper], [--no-helper], [--skip-helper]             # Indicates when to generate helper
                                                             # Default: true
  -e, [--template-engine=NAME]                               # Template engine to be invoked
                                                             # Default: erb
  -t, [--test-framework=NAME]                                # Test framework to be invoked
                                                             # Default: test_unit
      [--parent=PARENT]                                      # The parent class for the generated controller
      [--actions=one two three]                              # Actions for the resource controller
      [--database=DATABASE]                                  # The database for your model's migration.
                                                             # Possible values: primary, cache

Runtime options:
  -f, [--force]                                      # Overwrite files that already exist
  -p, [--pretend], [--no-pretend], [--skip-pretend]  # Run but do not make any changes
  -q, [--quiet], [--no-quiet]                        # Suppress status output
  -s, [--skip], [--no-skip]                          # Skip files that already exist

Rails options:
  -h, [--help], [--no-help]  # Show this help message and quit

Description:
    Generates a new controller and its views.

Example:
    bin/rails generate controller CreditCards open debit
`;

describe("generators", () => {
  it("lists generators by group", () => {
    const list = parseGeneratorList(LIST);
    expect(list.map((g) => g.name)).toEqual(["application_record", "controller", "model", "scaffold", "active_record:application_record", "active_record:multi_db", "test_unit:channel"]);
    expect(list[4].group).toBe("ActiveRecord");
    expect(parseGeneratorList("no list")).toEqual([]);
  });

  it("parses usage and options with types, aliases, defaults and possible values", () => {
    const help = parseGeneratorHelp(CONTROLLER);
    expect(help.usage).toBe("bin/rails generate controller NAME [action action] [options]");
    expect(help.args).toBe("NAME [action action]");
    const byName = Object.fromEntries(help.options.map((o) => [o.name, o]));
    expect(Object.keys(byName)).toEqual(["skip-routes", "helper", "template-engine", "test-framework", "parent", "actions", "database", "force", "skip"]);
    expect(byName.helper).toMatchObject({ type: "boolean", default: "true" });
    expect(byName["skip-routes"]).toMatchObject({ type: "boolean", default: "false", description: "Don't add routes to config/routes.rb." });
    expect(byName["template-engine"]).toMatchObject({ type: "string", alias: "e", default: "erb" });
    expect(byName.actions.type).toBe("array");
    expect(byName.database.values).toEqual(["primary", "cache"]);
    expect(byName.force.alias).toBe("f");
    expect(help.description).toBe("Generates a new controller and its views.");
  });

  it("builds the command, passing only options that differ from their defaults", () => {
    const { options } = parseGeneratorHelp(CONTROLLER);
    expect(generatorArgs("controller", "Posts index show", { helper: true, "template-engine": "erb" }, options)).toBe("bin/rails generate controller Posts index show");
    expect(generatorArgs("controller", "Admin::Posts", { helper: false, "skip-routes": true, "template-engine": "haml", actions: "a b", parent: "Base Controller" }, options, true)).toBe(
      "bin/rails generate controller Admin::Posts --skip-routes --no-helper --template-engine=haml --parent='Base Controller' --actions=a b --pretend",
    );
    expect(generatorArgs("model", "Post 'title:string{40}'", {}, [])).toBe("bin/rails generate model Post 'title:string{40}'");
    expect(splitArgs(`a "b c" 'd'`)).toEqual(["a", "b c", "d"]);
  });

  it("collects created files from generator output", () => {
    const out = `      invoke  active_record\n      create    db/migrate/20240101000000_create_posts.rb\n      create    app/models/post.rb\n      create    app/views/posts\n      create    app/views/posts/index.html.erb\n       force    config/locales/en.yml\n   identical    app/helpers/posts_helper.rb\n       route  resources :posts\n`;
    expect(createdFiles(out)).toEqual(["db/migrate/20240101000000_create_posts.rb", "app/models/post.rb", "app/views/posts/index.html.erb", "config/locales/en.yml"]);
  });
});
