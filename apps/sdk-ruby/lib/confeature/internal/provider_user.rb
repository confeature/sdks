# frozen_string_literal: true

# SPDX-License-Identifier: MIT

require_relative "../user"

module Confeature
  module Internal
    # The companion supplies its own targeting context on every evaluation.
    class ProviderUser < User
      attr_reader :flag_type

      def initialize(flag_type:, **attributes)
        @flag_type = flag_type
        super(**attributes)
      end
    end
  end
end
