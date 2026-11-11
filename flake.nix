{
  description = "aty.ch — static listing site for the Pajero";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in
    {
      # One toolchain, used identically by `nix develop -c ./build.sh` on a
      # workstation and by the Pages workflow in CI. That is the whole reason
      # this flake exists: the image pipeline bakes encoder output into the
      # deployed artefact, so a cwebp or avifenc that differs between laptop
      # and runner silently changes what visitors download.
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22

            # Image pipeline. magick resizes and reads geometry; the two
            # encoders are called directly rather than through magick's
            # delegates, because the delegate path does not expose the
            # encoder flags that matter here (-sharp_yuv, -s/speed).
            imagemagick
            libwebp
            libavif

            # Font pipeline — see tools/fonts.sh. Only needed when the
            # webfonts are regenerated, which is approximately never; the
            # woff2 output is committed.
            #
            # fonttools and brotli have to be in ONE python environment:
            # pyftsubset --flavor=woff2 imports brotli from its own
            # interpreter, so adding python3Packages.brotli alongside the
            # fonttools derivation leaves it invisible.
            (python3.withPackages (ps: [ ps.fonttools ps.brotli ]))
            google-fonts

            # QR code for the flyer.
            qrencode
          ];
        };
      });

      formatter = forAll (pkgs: pkgs.nixpkgs-fmt);
    };
}
