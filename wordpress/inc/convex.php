<?php
/**
 * The deployment the website shares with the mobile app. Everything a visitor
 * sees about plans and credits is read from it, so the theme never carries a
 * price, an allowance or a request cost of its own.
 */

defined( 'ABSPATH' ) || exit;

const FORGE_CONVEX_URL      = 'https://polished-ram-883.convex.cloud';
const FORGE_MOBILE_APP_URL  = 'https://xgamer791.github.io/forge-nexxus/';
const FORGE_SUPPORT_EMAIL   = 'support@forgenexxus.com';
const FORGE_CATALOG_TTL     = 10 * MINUTE_IN_SECONDS;

/**
 * Runs a public Convex query over HTTP. Returns null on any failure so callers
 * can render an honest empty state instead of made-up numbers.
 */
function forge_convex_query( string $path, array $args = [] ) {
	$response = wp_remote_post(
		FORGE_CONVEX_URL . '/api/query',
		[
			'timeout' => 8,
			'headers' => [ 'Content-Type' => 'application/json' ],
			'body'    => wp_json_encode(
				[
					'path'   => $path,
					'args'   => (object) $args,
					'format' => 'json',
				]
			),
		]
	);
	if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
		return null;
	}
	$body = json_decode( wp_remote_retrieve_body( $response ), true );
	if ( ! is_array( $body ) || ( $body['status'] ?? '' ) !== 'success' ) {
		return null;
	}
	return $body['value'] ?? null;
}

/**
 * The plan catalog: plans, top-up packs and what each request kind costs.
 * Cached briefly; the last good copy is kept so an outage shows yesterday's
 * catalog rather than nothing.
 */
function forge_catalog(): ?array {
	$cached = get_transient( 'forge_catalog' );
	if ( is_array( $cached ) ) {
		return forge_without_free_plan( $cached );
	}
	$fresh = forge_convex_query( 'billing:catalog' );
	if ( is_array( $fresh ) && ! empty( $fresh['plans'] ) ) {
		$fresh = forge_without_free_plan( $fresh );
		set_transient( 'forge_catalog', $fresh, FORGE_CATALOG_TTL );
		update_option( 'forge_catalog_last', $fresh, false );
		return $fresh;
	}
	$last = get_option( 'forge_catalog_last' );
	return is_array( $last ) ? forge_without_free_plan( $last ) : null;
}

/** Free is not a product. Drop it even if an older catalog still lists it. */
function forge_without_free_plan( array $catalog ): array {
	$plans = $catalog['plans'] ?? [];
	$catalog['plans'] = array_values(
		array_filter(
			is_array( $plans ) ? $plans : [],
			static function ( $plan ) {
				if ( ! is_array( $plan ) ) {
					return false;
				}
				$key     = (string) ( $plan['key'] ?? '' );
				$monthly = (int) round( (float) ( $plan['monthlyPriceCents'] ?? 0 ) );
				return 'free' !== $key && $monthly > 0;
			}
		)
	);
	return $catalog;
}

/** Same rule as the app: whole dollars when even, two decimals otherwise. */
function forge_money( $cents ): string {
	$cents = (int) round( (float) $cents );
	if ( 0 === $cents ) {
		return 'Free';
	}
	$decimals = $cents % 100 ? 2 : 0;
	return '$' . number_format( $cents / 100, $decimals );
}

/** The plan card bullets, in the order the app shows them. */
function forge_plan_features( array $plan ): array {
	$lines = [];
	if ( null === $plan['monthlyCredits'] ) {
		$lines[] = 'Unlimited credits';
	} elseif ( $plan['monthlyCredits'] > 0 ) {
		$lines[] = number_format( (float) $plan['monthlyCredits'] ) . ' credits a month';
	} else {
		$lines[] = number_format( (float) $plan['signupCredits'] ) . ' credits to start';
	}
	if ( null !== $plan['monthlyCredits'] && $plan['monthlyCredits'] > 0 && ! empty( $plan['signupCredits'] ) ) {
		$lines[] = number_format( (float) $plan['signupCredits'] ) . ' welcome credits';
	}
	if ( null === $plan['maxSites'] ) {
		$lines[] = 'Unlimited sites';
	} elseif ( 1 === (int) $plan['maxSites'] ) {
		$lines[] = '1 site';
	} else {
		$lines[] = 'Up to ' . (int) $plan['maxSites'] . ' sites';
	}
	if ( ! empty( $plan['visitorsPerMonth'] ) ) {
		$lines[] = 'Up to ' . number_format( (float) $plan['visitorsPerMonth'] ) . ' visitors a month';
	}
	if ( ! empty( $plan['customDomains'] ) ) {
		$lines[] = 'Custom domain';
	}
	if ( ! empty( $plan['removeBadge'] ) ) {
		$lines[] = 'No Forge badge';
	}
	if ( ! empty( $plan['codeDownload'] ) ) {
		$lines[] = 'Download your code';
	}
	if ( ! empty( $plan['topUps'] ) ) {
		$lines[] = 'Buy extra credits any time';
	}
	foreach ( (array) ( $plan['features'] ?? [] ) as $feature ) {
		$lines[] = (string) $feature;
	}
	return array_values( array_unique( $lines ) );
}

/** The plan cards, shared by the front page and the pricing page. */
function forge_render_plans( ?array $catalog, string $context = 'home' ): void {
	if ( ! $catalog || empty( $catalog['plans'] ) ) {
		?>
		<div class="plans-unavailable">
			<p>Plans are loading slowly right now. Open Forge to see them live, or try again in a moment.</p>
			<a class="button" href="<?php echo esc_url( home_url( '/app/' ) ); ?>">Open Forge</a>
		</div>
		<?php
		return;
	}
	$plans       = $catalog['plans'];
	$highlighted = 'starter';
	?>
	<div class="plans" data-plans data-interval="month">
		<?php foreach ( $plans as $plan ) :
			$monthly = (int) round( (float) $plan['monthlyPriceCents'] );
			$yearly  = (int) round( (float) $plan['yearlyPriceCents'] );
			$per_mo  = $yearly ? (int) round( $yearly / 12 ) : 0;
			?>
			<article class="plan <?php echo $plan['key'] === $highlighted ? 'is-highlight' : ''; ?>" data-plan="<?php echo esc_attr( $plan['key'] ); ?>">
				<header class="plan-head">
					<h3><?php echo esc_html( $plan['name'] ); ?></h3>
					<?php if ( $plan['key'] === $highlighted ) : ?><span class="plan-badge">Most people start here</span><?php endif; ?>
				</header>
				<p class="plan-tagline"><?php echo esc_html( $plan['tagline'] ); ?></p>
				<p class="plan-price">
					<?php if ( 0 === $monthly ) : ?>
						<strong>Free</strong><span>forever</span>
					<?php else : ?>
						<strong data-price-month="<?php echo esc_attr( forge_money( $monthly ) ); ?>" data-price-year="<?php echo esc_attr( forge_money( $per_mo ) ); ?>"><?php echo esc_html( forge_money( $monthly ) ); ?></strong><span>/ month</span>
					<?php endif; ?>
				</p>
				<p class="plan-billing">
					<?php if ( $yearly ) : ?>
						<span data-billing-month><?php echo esc_html( 'Billed monthly, or ' . forge_money( $yearly ) . ' a year' ); ?></span>
						<span data-billing-year hidden><?php echo esc_html( 'Billed yearly as ' . forge_money( $yearly ) ); ?></span>
					<?php else : ?>
						<span>No card needed</span>
					<?php endif; ?>
				</p>
				<ul class="plan-features">
					<?php foreach ( forge_plan_features( $plan ) as $line ) : ?>
						<li><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 12 5 5L20 6"/></svg><span><?php echo esc_html( $line ); ?></span></li>
					<?php endforeach; ?>
				</ul>
				<a class="button <?php echo $plan['key'] === $highlighted ? '' : 'button-ghost'; ?> plan-cta" href="<?php echo esc_url( home_url( '/app/?screen=plan' ) ); ?>">
					<?php echo 0 === $monthly ? 'Start free' : 'Choose ' . esc_html( $plan['name'] ); ?>
				</a>
			</article>
		<?php endforeach; ?>
	</div>
	<?php
}
