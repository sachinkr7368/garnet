import { describe, expect, it } from "vitest";
import { constantName, implementationPattern } from "../implementations";

const re = (name: string) => new RegExp(implementationPattern(name));

describe("implementation search", () => {
  it("takes the constant at the caret", () => {
    expect(constantName("ApplicationRecord")).toBe("ApplicationRecord");
    expect(constantName("Admin::Base")).toBe("Base");
    expect(constantName("post")).toBeNull();
    expect(constantName(undefined)).toBeNull();
  });

  it("matches subclasses, namespaced or not", () => {
    const r = re("ApplicationRecord");
    expect(r.test("class Post < ApplicationRecord")).toBe(true);
    expect(r.test("  class Admin::User<::ApplicationRecord # note")).toBe(true);
    expect(r.test("class Post < ApplicationRecordBase")).toBe(false);
    expect(r.test("class ApplicationRecord < ActiveRecord::Base")).toBe(false);
    expect(r.test("# class Post < ApplicationRecord")).toBe(false);
  });

  it("matches include, extend and prepend, including lists", () => {
    const r = re("Searchable");
    expect(r.test("  include Searchable")).toBe(true);
    expect(r.test("  extend Concerns::Searchable")).toBe(true);
    expect(r.test("  include Comparable, Searchable")).toBe(true);
    expect(r.test("  prepend(Searchable)")).toBe(true);
    expect(r.test("  include Searchable::Helpers")).toBe(false);
    expect(r.test("  include SearchableThing")).toBe(false);
  });
});
