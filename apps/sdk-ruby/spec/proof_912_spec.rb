# frozen_string_literal: true

# SPDX-License-Identifier: MIT
#
# PROOF (#912, FR-013): a deliberate break. This pull request is closed unmerged.
RSpec.describe Confeature do
  it "turns the ruby gate red" do
    expect(described_class.name).to eq("NotConfeature")
  end
end
