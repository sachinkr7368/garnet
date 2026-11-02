export interface Snippet {
  prefix: string;
  body: string;
  description: string;
}

const RUBY: Snippet[] = [
  { prefix: "def", body: "def ${1:method_name}${2:(${3:args})}\n\t$0\nend", description: "Method definition" },
  { prefix: "defs", body: "def self.${1:method_name}${2:(${3:args})}\n\t$0\nend", description: "Class method definition" },
  { prefix: "class", body: "class ${1:ClassName}\n\t$0\nend", description: "Class" },
  { prefix: "classi", body: "class ${1:ClassName} < ${2:ParentClass}\n\t$0\nend", description: "Class with superclass" },
  { prefix: "module", body: "module ${1:ModuleName}\n\t$0\nend", description: "Module" },
  { prefix: "each", body: "each do |${1:item}|\n\t$0\nend", description: "each do |item| … end" },
  { prefix: "eachi", body: "each_with_index do |${1:item}, ${2:index}|\n\t$0\nend", description: "each_with_index block" },
  { prefix: "map", body: "map { |${1:item}| $0 }", description: "map { |item| … }" },
  { prefix: "do", body: "do\n\t$0\nend", description: "do … end block" },
  { prefix: "dop", body: "do |${1:arg}|\n\t$0\nend", description: "do |arg| … end block" },
  { prefix: "if", body: "if ${1:condition}\n\t$0\nend", description: "if … end" },
  { prefix: "unless", body: "unless ${1:condition}\n\t$0\nend", description: "unless … end" },
  { prefix: "begin", body: "begin\n\t$1\nrescue ${2:StandardError} => ${3:e}\n\t$0\nend", description: "begin … rescue … end" },
  { prefix: "case", body: "case ${1:value}\nwhen ${2:pattern}\n\t$0\nend", description: "case … when … end" },
];

const RSPEC: Snippet[] = [
  { prefix: "describe", body: "describe ${1:\"${2:subject}\"} do\n\t$0\nend", description: "RSpec describe block" },
  { prefix: "context", body: "context \"${1:when something}\" do\n\t$0\nend", description: "RSpec context block" },
  { prefix: "it", body: "it \"${1:does something}\" do\n\t$0\nend", description: "RSpec example" },
  { prefix: "let", body: "let(:${1:name}) { $0 }", description: "RSpec let" },
  { prefix: "let!", body: "let!(:${1:name}) { $0 }", description: "RSpec let! (eager)" },
  { prefix: "subject", body: "subject { $0 }", description: "RSpec subject" },
  { prefix: "before", body: "before do\n\t$0\nend", description: "RSpec before hook" },
  { prefix: "after", body: "after do\n\t$0\nend", description: "RSpec after hook" },
  { prefix: "expect", body: "expect(${1:actual}).to ${2:eq}(${3:expected})", description: "RSpec expectation" },
];

const ERB: Snippet[] = [
  { prefix: "pe", body: "<%= $0 %>", description: "ERB output tag <%= %>" },
  { prefix: "er", body: "<% $0 %>", description: "ERB code tag <% %>" },
  { prefix: "ec", body: "<%# $0 %>", description: "ERB comment tag <%# %>" },
  { prefix: "eif", body: "<% if ${1:condition} %>\n\t$0\n<% end %>", description: "ERB if block" },
  { prefix: "eeach", body: "<% ${1:items}.each do |${2:item}| %>\n\t$0\n<% end %>", description: "ERB each block" },
  { prefix: "eend", body: "<% end %>", description: "ERB end tag" },
];

export const isSpec = (path: string) => /_spec\.rb$/.test(path);

/// Live templates for a document: Ruby everywhere Ruby is edited, RSpec in *_spec.rb, tags in ERB.
export function snippetsFor(language: string, path: string): Snippet[] {
  if (language === "erb") return ERB;
  if (language !== "ruby") return [];
  return isSpec(path) ? [...RUBY, ...RSPEC] : RUBY;
}
