class Titan < Formula
  desc "Local-first AI agent platform with approvals and multi-channel integrations"
  homepage "https://github.com/Djtony707/TITAN"
  license "MIT"

  # Stable release metadata should be set when creating tagged releases.
  # url "https://github.com/Djtony707/TITAN/archive/refs/tags/v0.1.0.tar.gz"
  # sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"

  head "https://github.com/Djtony707/TITAN.git", branch: "main"

  depends_on "rust" => :build

  def install
    system "cargo", "install", *std_cargo_args(path: "crates/titan-cli")
  end

  test do
    output = shell_output("#{bin}/titan doctor 2>&1")
    assert_match "doctor", output
  end
end
